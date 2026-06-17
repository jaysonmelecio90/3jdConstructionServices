import os
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _build_mysql_uri():
    """Build a MySQL connection string from individual env vars, or fall back
    to DATABASE_URL if set explicitly."""
    explicit = os.environ.get("DATABASE_URL")
    if explicit:
        return explicit

    user = os.environ.get("MYSQL_USER", "root")
    password = os.environ.get("MYSQL_PASSWORD", "")
    host = os.environ.get("MYSQL_HOST", "127.0.0.1")
    port = os.environ.get("MYSQL_PORT", "3306")
    name = os.environ.get("MYSQL_DB", "cdengineering")

    pwd_part = f":{quote_plus(password)}" if password else ""
    return f"mysql+pymysql://{user}{pwd_part}@{host}:{port}/{name}?charset=utf8mb4"


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-in-production-please")
    SQLALCHEMY_DATABASE_URI = _build_mysql_uri()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
    }

    COMPANY_NAME = os.environ.get("COMPANY_NAME", "CD Engineering")
    COMPANY_ADDRESS = os.environ.get(
        "COMPANY_ADDRESS", "Purok-3, Barangay Corte-Baud, Getafe Bohol"
    )
    COMPANY_PHONE = os.environ.get("COMPANY_PHONE", "09508211886 / 09952236477")
    COMPANY_EMAIL = os.environ.get("COMPANY_EMAIL", "cdengineering2014@gmail.com")

    NEXT_PROJECT_NUMBER_START = 1000
