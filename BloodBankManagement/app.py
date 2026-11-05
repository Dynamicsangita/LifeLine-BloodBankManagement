from datetime import date
from functools import wraps
from flask import Flask, render_template, request, redirect, url_for, flash, session
from werkzeug.security import generate_password_hash, check_password_hash
import mysql.connector
from mysql.connector import Error
from config import Config

app = Flask(__name__)
app.config.from_object(Config)
BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

# RBC compatibility: receiver blood group -> acceptable donor blood groups.
COMPATIBLE_DONORS = {
    'A+': ['A+', 'A-', 'O+', 'O-'], 'A-': ['A-', 'O-'],
    'B+': ['B+', 'B-', 'O+', 'O-'], 'B-': ['B-', 'O-'],
    'AB+': BLOOD_GROUPS.copy(), 'AB-': ['AB-', 'A-', 'B-', 'O-'],
    'O+': ['O+', 'O-'], 'O-': ['O-']
}

def get_db():
    return mysql.connector.connect(
        host=app.config['MYSQL_HOST'], user=app.config['MYSQL_USER'],
        password=app.config['MYSQL_PASSWORD'], database=app.config['MYSQL_DATABASE']
    )

def query_db(sql, params=None, one=False, commit=False, rowcount=False):
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute(sql, params or ())
        if commit:
            conn.commit()
            if rowcount:
                return cursor.rowcount
            return cursor.lastrowid
        result = cursor.fetchone() if one else cursor.fetchall()
        return result
    finally:
        cursor.close()
        conn.close()

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'user_id' not in session:
            flash('Please log in to continue.', 'warning')
            return redirect(url_for('login'))
        return view(*args, **kwargs)
    return wrapped

def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if session.get('role') != 'admin':
            flash('Administrator access required.', 'danger')
            return redirect(url_for('dashboard'))
        return view(*args, **kwargs)
    return wrapped

@app.context_processor
def inject_globals():
    return {'blood_groups': BLOOD_GROUPS, 'current_year': date.today().year}

@app.route('/')
def index():
    try:
        total_donors = query_db('SELECT COUNT(*) AS n FROM donors WHERE available=1', one=True)['n']
        total_units = query_db('SELECT COALESCE(SUM(units),0) AS n FROM blood_inventory', one=True)['n']
        inventory = query_db('SELECT * FROM blood_inventory ORDER BY FIELD(blood_group, %s,%s,%s,%s,%s,%s,%s,%s)', tuple(BLOOD_GROUPS))
    except Error:
        total_donors, total_units, inventory = 0, 0, []
        flash('Database is not connected yet. Please configure MySQL and import bloodbank.sql.', 'warning')
    return render_template('index.html', total_donors=total_donors, total_units=total_units, inventory=inventory)

@app.route('/register', methods=['GET','POST'])
def register():
    if request.method == 'POST':
        name = request.form.get('full_name','').strip()
        email = request.form.get('email','').strip().lower()
        phone = request.form.get('phone','').strip()
        password = request.form.get('password','')
        if not name or not email or not phone or len(password) < 8:
            flash('Fill all fields. Password must contain at least 8 characters.', 'danger')
            return render_template('register.html')
        try:
            query_db('INSERT INTO users(full_name,email,phone,password_hash) VALUES(%s,%s,%s,%s)',
                     (name,email,phone,generate_password_hash(password)), commit=True)
            flash('Account created successfully. Please log in.', 'success')
            return redirect(url_for('login'))
        except Error as e:
            if getattr(e, 'errno', None) == 1062:
                flash('This email is already registered.', 'warning')
            else:
                flash('Could not create account. Check database connection.', 'danger')
    return render_template('register.html')

@app.route('/login', methods=['GET','POST'])
def login():
    if request.method == 'POST':
        email = request.form.get('email','').strip().lower()
        password = request.form.get('password','')
        user = query_db('SELECT * FROM users WHERE email=%s', (email,), one=True)
        if user and check_password_hash(user['password_hash'], password):
            session.clear()
            session['user_id'] = user['id']
            session['name'] = user['full_name']
            session['role'] = user['role']
            flash(f"Welcome, {user['full_name']}!", 'success')
            return redirect(url_for('dashboard'))
        flash('Invalid email or password.', 'danger')
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    flash('You have been logged out.', 'info')
    return redirect(url_for('index'))

@app.route('/dashboard')
@login_required
def dashboard():
    donor = query_db('SELECT * FROM donors WHERE user_id=%s', (session['user_id'],), one=True)
    requests = query_db('SELECT * FROM blood_requests WHERE user_id=%s ORDER BY created_at DESC', (session['user_id'],))
    inventory = query_db('SELECT * FROM blood_inventory ORDER BY blood_group')
    blood_banks = query_db(
        'SELECT * FROM blood_banks WHERE verified=1 ORDER BY city, name'
    )
    return render_template(
        'dashboard.html', donor=donor, requests=requests, inventory=inventory,
        blood_banks=blood_banks,
    )

@app.route('/blood-banks')
def blood_banks():
    city = request.args.get('city', '').strip()[:100]
    sql = 'SELECT * FROM blood_banks WHERE verified=1'
    params = ()
    if city:
        sql += ' AND city LIKE %s'
        params = (f'%{city}%',)
    banks = query_db(sql + ' ORDER BY city, name', params)
    return render_template('blood_banks.html', banks=banks, city=city)

@app.route('/donor/register', methods=['GET','POST'])
@login_required
def donor_register():
    donor = query_db('SELECT * FROM donors WHERE user_id=%s', (session['user_id'],), one=True)
    if request.method == 'POST':
        try:
            age = int(request.form.get('age','0'))
        except ValueError:
            age = 0
        group = request.form.get('blood_group')
        city = request.form.get('city','').strip()
        if age < 18 or age > 65 or group not in BLOOD_GROUPS or not city:
            flash('Please check age (18–65), blood group, and city.', 'danger')
            return render_template('donor_register.html', donor=donor)
        gender = request.form.get('gender','Prefer not to say')
        address = request.form.get('address','').strip()
        last_date = request.form.get('last_donation_date') or None
        available = 1 if request.form.get('available') == 'on' else 0
        if donor:
            query_db('UPDATE donors SET blood_group=%s,age=%s,gender=%s,city=%s,address=%s,last_donation_date=%s,available=%s WHERE user_id=%s',
                     (group,age,gender,city,address,last_date,available,session['user_id']), commit=True)
        else:
            query_db('INSERT INTO donors(user_id,blood_group,age,gender,city,address,last_donation_date,available) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                     (session['user_id'],group,age,gender,city,address,last_date,available), commit=True)
        flash('Donor profile saved!', 'success')
        return redirect(url_for('dashboard'))
    return render_template('donor_register.html', donor=donor)

@app.route('/donors')
def search_donors():
    group = request.args.get('blood_group','')
    city = request.args.get('city','').strip()
    donors = []
    if group in BLOOD_GROUPS:
        donors = query_db('''SELECT d.blood_group,d.age,d.gender,d.city,d.last_donation_date,u.full_name,u.phone
                           FROM donors d JOIN users u ON d.user_id=u.id
                           WHERE d.available=1 AND d.blood_group=%s AND d.city LIKE %s
                           ORDER BY d.created_at DESC''', (group, f'%{city}%'))
    return render_template('search_donors.html', donors=donors, selected_group=group, city=city)

@app.route('/request-blood', methods=['GET','POST'])
@login_required
def request_blood():
    if request.method == 'POST':
        try:
            units = int(request.form.get('units','0'))
        except ValueError:
            units = 0
        group = request.form.get('blood_group')
        patient = request.form.get('patient_name','').strip()
        hospital = request.form.get('hospital','').strip()
        city = request.form.get('city','').strip()
        phone = request.form.get('contact_phone','').strip()
        urgency = request.form.get('urgency','Normal')
        if group not in BLOOD_GROUPS or not (1 <= units <= 20) or not all([patient,hospital,city,phone]) or urgency not in ['Normal','Urgent','Emergency']:
            flash('Please fill all fields correctly. Units must be between 1 and 20.', 'danger')
            return render_template('request_blood.html')
        query_db('INSERT INTO blood_requests(user_id,patient_name,blood_group,units,hospital,city,contact_phone,urgency) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                 (session['user_id'],patient,group,units,hospital,city,phone,urgency), commit=True)
        flash('Blood request submitted. The blood bank team will review it.', 'success')
        return redirect(url_for('dashboard'))
    return render_template('request_blood.html')

@app.route('/request-blood/<int:request_id>/cancel', methods=['POST'])
@login_required
def cancel_blood_request(request_id):
    updated = query_db(
        "UPDATE blood_requests SET status='Cancelled' "
        "WHERE id=%s AND user_id=%s AND status='Pending'",
        (request_id, session['user_id']), commit=True, rowcount=True
    )
    if updated:
        flash(f'Request #{request_id} cancelled.', 'success')
    else:
        flash('This request could not be cancelled. It may no longer be pending.', 'warning')
    return redirect(url_for('dashboard'))

@app.route('/emergency-match')
def emergency_match():
    group = request.args.get('blood_group','')
    city = request.args.get('city','').strip()
    donors = []
    if group in COMPATIBLE_DONORS:
        compatible = COMPATIBLE_DONORS[group]
        placeholders = ','.join(['%s'] * len(compatible))
        sql = f'''SELECT d.blood_group,d.age,d.gender,d.city,u.full_name,u.phone
                  FROM donors d JOIN users u ON d.user_id=u.id
                  WHERE d.available=1 AND d.blood_group IN ({placeholders}) AND d.city LIKE %s
                  ORDER BY d.blood_group'''
        donors = query_db(sql, tuple(compatible) + (f'%{city}%',))
    return render_template('emergency_match.html', donors=donors, selected_group=group, city=city,
                         compatible_groups=COMPATIBLE_DONORS.get(group, []))

@app.route('/admin')
@login_required
@admin_required
def admin():
    requests = query_db('''SELECT r.*,u.full_name AS requester FROM blood_requests r
                           JOIN users u ON r.user_id=u.id ORDER BY r.created_at DESC''')
    inventory = query_db('SELECT * FROM blood_inventory ORDER BY blood_group')
    donor_count = query_db('SELECT COUNT(*) AS n FROM donors', one=True)['n']
    return render_template('admin.html', requests=requests, inventory=inventory, donor_count=donor_count)

@app.route('/admin/inventory', methods=['POST'])
@login_required
@admin_required
def update_inventory():
    group = request.form.get('blood_group')
    try:
        units = int(request.form.get('units','-1'))
    except ValueError:
        units = -1
    if group not in BLOOD_GROUPS or units < 0 or units > 100000:
        flash('Invalid blood group or units.', 'danger')
    else:
        query_db('UPDATE blood_inventory SET units=%s WHERE blood_group=%s', (units,group), commit=True)
        flash('Inventory updated.', 'success')
    return redirect(url_for('admin'))

@app.route('/admin/request/<int:request_id>/<status>', methods=['POST'])
@login_required
@admin_required
def update_request(request_id, status):
    allowed_previous_statuses = {
        'Approved': ['Pending'],
        'Fulfilled': ['Approved'],
        'Rejected': ['Pending', 'Approved'],
    }
    if status not in allowed_previous_statuses:
        flash('Invalid status.', 'danger')
    else:
        previous_statuses = allowed_previous_statuses[status]
        placeholders = ','.join(['%s'] * len(previous_statuses))
        updated = query_db(
            f'UPDATE blood_requests SET status=%s WHERE id=%s AND status IN ({placeholders})',
            (status, request_id, *previous_statuses), commit=True, rowcount=True
        )
        if updated:
            flash(f'Request #{request_id} marked {status.lower()}.', 'success')
        else:
            flash('Request status was not changed. Refresh the page and try again.', 'warning')
    return redirect(url_for('admin'))

@app.errorhandler(404)
def not_found(error):
    return render_template('404.html'), 404


if __name__ == '__main__':
    app.run(debug=True)
