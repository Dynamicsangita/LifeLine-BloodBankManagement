import importlib
import os
import unittest
from unittest.mock import patch

os.environ['SECRET_KEY'] = 'test-secret-key-for-flask-workflow-tests-only'

import config
from app import app


class RequestWorkflowTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True, SECRET_KEY='test-secret-key-for-flask-workflow-tests-only')
        self.client = app.test_client()

    def test_flask_secret_key_must_be_explicit_and_long_enough(self):
        for secret in ('', 'too-short'):
            with self.subTest(secret=secret):
                with patch.dict(os.environ, {'SECRET_KEY': secret}):
                    with self.assertRaisesRegex(RuntimeError, 'SECRET_KEY'):
                        importlib.reload(config)
                importlib.reload(config)

    def login_as(self, **values):
        with self.client.session_transaction() as session:
            session.update(values)

    @patch('app.query_db', return_value=1)
    def test_owner_can_cancel_pending_request(self, query_db):
        self.login_as(user_id=12, role='user')

        response = self.client.post('/request-blood/34/cancel')

        self.assertEqual(response.status_code, 302)
        self.assertIn("status='Cancelled'", query_db.call_args.args[0])
        self.assertIn("status='Pending'", query_db.call_args.args[0])
        self.assertEqual(query_db.call_args.args[1], (34, 12))
        self.assertTrue(query_db.call_args.kwargs['rowcount'])

    @patch('app.query_db', return_value=0)
    def test_non_pending_request_is_not_cancelled(self, query_db):
        self.login_as(user_id=12, role='user')

        response = self.client.post('/request-blood/34/cancel')

        self.assertEqual(response.status_code, 302)
        self.assertIn("status='Pending'", query_db.call_args.args[0])

    @patch('app.query_db', return_value=1)
    def test_admin_can_only_fulfill_approved_request(self, query_db):
        self.login_as(user_id=1, role='admin')

        response = self.client.post('/admin/request/34/Fulfilled')

        self.assertEqual(response.status_code, 302)
        self.assertIn("status IN (%s)", query_db.call_args.args[0])
        self.assertEqual(query_db.call_args.args[1], ('Fulfilled', 34, 'Approved'))
        self.assertTrue(query_db.call_args.kwargs['rowcount'])

    @patch('app.query_db', side_effect=[
        None,
        [
            {'id': 34, 'patient_name': 'Patient A', 'blood_group': 'O+',
             'units': 2, 'hospital': 'City Hospital', 'urgency': 'Urgent',
             'status': 'Pending'},
            {'id': 35, 'patient_name': 'Patient B', 'blood_group': 'A+',
             'units': 1, 'hospital': 'Town Hospital', 'urgency': 'Normal',
             'status': 'Cancelled'},
        ],
        [],
        [],
    ])
    def test_dashboard_only_offers_cancellation_for_pending_requests(self, query_db):
        self.login_as(user_id=12, role='user', name='Donor')

        response = self.client.get('/dashboard')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data.count(b'Cancel</button>'), 1)
        self.assertIn(b'Cancelled', response.data)

    @patch('app.query_db', side_effect=[
        None,
        [],
        [],
        [{'name': 'Central Blood Bank', 'address': '12 Main Road', 'city': 'Cuttack',
          'phone': '0123456789', 'email': 'bank@example.org', 'verified': 1}],
    ])
    def test_dashboard_displays_verified_banks_loaded_from_database(self, query_db):
        self.login_as(user_id=12, role='user', name='Donor')

        response = self.client.get('/dashboard')

        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Central Blood Bank', response.data)
        self.assertIn(b'Cuttack', response.data)
        self.assertIn('FROM blood_banks WHERE verified=1', query_db.call_args_list[3].args[0])

    @patch('app.query_db', return_value=[
        {'name': 'Central Blood Bank', 'address': '12 Main Road', 'city': 'Cuttack',
         'phone': '0123456789', 'email': 'bank@example.org', 'verified': 1},
    ])
    def test_blood_bank_directory_queries_and_renders_city_results(self, query_db):
        response = self.client.get('/blood-banks?city=Cuttack')

        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Central Blood Bank', response.data)
        self.assertIn(b'12 Main Road', response.data)
        self.assertEqual(query_db.call_args.args[1], ('%Cuttack%',))
        self.assertIn('verified=1', query_db.call_args.args[0])

    @patch('app.query_db', side_effect=[
        [],
        [{'blood_group': 'O+', 'units': 7}],
        {'n': 1},
    ])
    def test_admin_dashboard_displays_inventory(self, query_db):
        self.login_as(user_id=1, role='admin')

        response = self.client.get('/admin')

        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Current blood inventory', response.data)
        self.assertIn(b'7', response.data)


if __name__ == '__main__':
    unittest.main()
