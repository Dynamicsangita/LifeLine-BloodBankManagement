CREATE DATABASE IF NOT EXISTS bloodbank_db;
USE bloodbank_db;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(120) NOT NULL UNIQUE,
    phone VARCHAR(20) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('user','admin') NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS donors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
    age TINYINT UNSIGNED NOT NULL,
    gender VARCHAR(30),
    city VARCHAR(100) NOT NULL,
    address VARCHAR(255),
    last_donation_date DATE NULL,
    available TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_donor_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blood_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL UNIQUE,
    units INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blood_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    patient_name VARCHAR(100) NOT NULL,
    blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
    units INT UNSIGNED NOT NULL,
    hospital VARCHAR(150) NOT NULL,
    city VARCHAR(100) NOT NULL,
    contact_phone VARCHAR(20) NOT NULL,
    urgency ENUM('Normal','Urgent','Emergency') NOT NULL DEFAULT 'Normal',
    status ENUM('Pending','Approved','Fulfilled','Rejected','Cancelled') NOT NULL DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_request_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blood_banks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    address VARCHAR(255) NOT NULL,
    city VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(120),
    verified TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_blood_banks_city_verified (city, verified)
);

INSERT IGNORE INTO blood_inventory (blood_group, units) VALUES
('A+',0),('A-',0),('B+',0),('B-',0),('AB+',0),('AB-',0),('O+',0),('O-',0);

-- After registering your account, make it admin using:
-- UPDATE users SET role='admin' WHERE email='your-email@example.com';
