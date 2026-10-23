"""Application settings, read from environment variables (and backend/.env)."""

import re
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", extra="ignore")

    app_env: str = "development"
    port: int = 5000

    # Databases
    database_url: str = "postgres://shop:shop@localhost:5432/shop"
    # Alternative to DATABASE_URL (used on AWS, where ECS injects the password from Secrets Manager)
    db_host: str = ""
    db_port: int = 5432
    db_name: str = "veyra"
    db_user: str = "veyra"
    db_password: str = ""
    mongo_uri: str = "mongodb://localhost:27017/shop"
    # Optional: keep all tables in their own schema, e.g. when sharing a database with another app
    pg_schema: str = ""
    # asyncpg caches prepared statements; set 0 behind PgBouncer / RDS Proxy (or PGlite in tests)
    pg_statement_cache_size: int = 100

    # Auth
    jwt_secret: str = "dev-secret"
    jwt_expires_in: str = "7d"
    google_client_id: str = ""

    # Other services
    ai_service_url: str = "http://localhost:8100"  # 8000 is often taken by other local FastAPI apps
    cors_origin: str = "http://localhost:5173"  # comma-separated list
    site_url: str = ""  # public storefront URL for sitemap / canonical links (default: first CORS origin)
    # The built storefront's index.html (e.g. http://frontend/index.html in Docker). Lets /api/seo/page serve
    # product and category pages with their title, description, preview card and content already in the HTML.
    frontend_index_url: str = ""

    # Email (payment OTPs, support replies). Without SMTP_HOST emails are logged instead.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_pass: str = ""
    mail_from: str = "Arvixa <no-reply@arvixa.example>"
    otp_ttl_minutes: int = 5

    # Online payments through Razorpay (an RBI-authorised payment aggregator): UPI, net banking, cards, wallets.
    # Test keys (rzp_test_...) from https://dashboard.razorpay.com/app/keys; without them checkout offers cash on delivery
    # plus the demo OTP payment used in development.
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""
    razorpay_webhook_secret: str = ""

    # Mobile OTPs by SMS and WhatsApp through Twilio (https://console.twilio.com). Without them, development
    # shows the code on screen instead of sending it.
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_sms_from: str = ""  # an SMS-capable Twilio number, e.g. +1415...
    twilio_whatsapp_from: str = ""  # e.g. whatsapp:+14155238886 (Twilio sandbox) or your approved sender

    # Key that encrypts sensitive data at rest (seller bank account numbers). Generate one with:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # Development falls back to a key derived from JWT_SECRET; production refuses to start without one.
    data_encryption_key: str = ""

    # Product media storage (images, videos, audio): S3 when S3_BUCKET is set, else the local uploads/ folder
    aws_region: str = "ap-south-1"
    s3_bucket: str = ""
    s3_public_url: str = ""  # e.g. a CloudFront domain in front of the bucket
    upload_dir: str = str(BASE_DIR / "uploads")

    # Analytics
    timezone: str = "Asia/Kolkata"
    analytics_cache_minutes: int = 30

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def postgres_dsn(self) -> str:
        if not self.db_host:
            return self.database_url
        from urllib.parse import quote

        return f"postgres://{quote(self.db_user)}:{quote(self.db_password, safe='')}@{self.db_host}:{self.db_port}/{self.db_name}"

    @property
    def analytics_schema(self) -> str:
        """Schema of the read-only reporting views the AI data analyst queries (see db/schema.sql)."""
        return f"{self.pg_schema}_analytics" if self.pg_schema else "analytics"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origin.split(",") if o.strip()]

    @property
    def jwt_expires_seconds(self) -> int:
        """Accepts the same format as the old Node API: "7d", "12h", "30m", "3600"."""
        match = re.fullmatch(r"(\d+)\s*([smhd]?)", self.jwt_expires_in.strip())
        if not match:
            return 7 * 86400
        value, unit = int(match[1]), match[2] or "s"
        return value * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.is_production and settings.jwt_secret in ("dev-secret", "change-me"):
        raise RuntimeError("Set a strong JWT_SECRET before running in production")
    if settings.is_production and not settings.data_encryption_key:
        raise RuntimeError("Set DATA_ENCRYPTION_KEY before running in production (it encrypts seller bank details)")
    return settings
