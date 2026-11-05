import os
from dotenv import load_dotenv

load_dotenv()

secret_key = os.getenv('SECRET_KEY')
if not secret_key or len(secret_key) < 32:
    raise RuntimeError('Set SECRET_KEY to a random value of at least 32 characters before starting the Flask app.')


class Config:
    SECRET_KEY = secret_key
    MYSQL_HOST = os.getenv('DB_HOST', 'localhost')
    MYSQL_USER = os.getenv('DB_USER', 'root')
    MYSQL_PASSWORD = os.getenv('DB_PASSWORD', '')
    MYSQL_DATABASE = os.getenv('DB_NAME', 'bloodbank_db')
