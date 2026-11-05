USE bloodbank_db;

ALTER TABLE blood_requests
MODIFY status ENUM('Pending','Approved','Fulfilled','Rejected','Cancelled')
NOT NULL DEFAULT 'Pending';
