"""Check every external account the store is configured to use - without printing any secret.

    python -m scripts.check_connections

Reads backend/.env (or the environment): PostgreSQL (local or AWS RDS), MongoDB (local or Atlas),
AWS S3, SMTP email, Razorpay and Twilio. Each line says OK, NOT SET (optional, not configured) or FAILED
with the reason, so you can see at a glance whether your own accounts are connected.
"""

import asyncio
import smtplib
import ssl
import sys
from urllib.parse import urlparse

import httpx

from app.core.config import get_settings

RESULTS: list[tuple[str, str, str]] = []


def report(name: str, status: str, detail: str = "") -> None:
    RESULTS.append((name, status, detail))


def host_of(url: str) -> str:
    """Hostname only (no user, password or database name)."""
    try:
        return (
            urlparse(
                url.replace("mongodb+srv://", "https://").replace("mongodb://", "https://").replace("postgres://", "https://")
            ).hostname
            or "?"
        )
    except ValueError:
        return "?"


async def check_postgres(s) -> None:
    import asyncpg

    dsn = s.postgres_dsn
    try:
        conn = await asyncpg.connect(dsn, timeout=10)
        try:
            version = await conn.fetchval("SHOW server_version")
            users = await conn.fetchval(f"SELECT COUNT(*) FROM {s.pg_schema + '.' if s.pg_schema else ''}users")
        finally:
            await conn.close()
        where = "AWS RDS" if "rds.amazonaws.com" in dsn else host_of(dsn)
        report("PostgreSQL", "OK", f"{where} · server {version} · {users} users")
    except Exception as e:  # noqa: BLE001
        report("PostgreSQL", "FAILED", f"{host_of(dsn)}: {type(e).__name__}: {str(e)[:120]}")


async def check_mongo(s) -> None:
    from pymongo import AsyncMongoClient

    client = AsyncMongoClient(s.mongo_uri, serverSelectionTimeoutMS=8000)
    try:
        db = client.get_default_database(default="shop")
        await db.command("ping")
        count = await db.products.estimated_document_count()
        where = "MongoDB Atlas" if ".mongodb.net" in s.mongo_uri else host_of(s.mongo_uri)
        report("MongoDB", "OK", f"{where} · database '{db.name}' · {count} products")
    except Exception as e:  # noqa: BLE001
        report("MongoDB", "FAILED", f"{host_of(s.mongo_uri)}: {type(e).__name__}: {str(e)[:120]}")
    finally:
        await client.close()


def check_s3(s) -> None:
    if not s.s3_bucket:
        report("AWS S3 (media)", "NOT SET", "uploads are saved to backend/uploads/ - set S3_BUCKET to use your AWS account")
        return
    try:
        import boto3

        sts = boto3.client("sts", region_name=s.aws_region).get_caller_identity()
        boto3.client("s3", region_name=s.aws_region).head_bucket(Bucket=s.s3_bucket)
        report("AWS S3 (media)", "OK", f"bucket '{s.s3_bucket}' in {s.aws_region} · AWS account {sts['Account']}")
    except Exception as e:  # noqa: BLE001
        report("AWS S3 (media)", "FAILED", f"bucket '{s.s3_bucket}': {type(e).__name__}: {str(e)[:120]}")


def check_smtp(s) -> None:
    if not s.smtp_host:
        report("Email (SMTP)", "NOT SET", "OTP codes are shown on screen in development - set SMTP_* to email them")
        return
    try:
        cls = smtplib.SMTP_SSL if s.smtp_port == 465 else smtplib.SMTP
        kwargs = {"context": ssl.create_default_context()} if s.smtp_port == 465 else {}
        with cls(s.smtp_host, s.smtp_port, timeout=10, **kwargs) as smtp:
            if s.smtp_port != 465:
                smtp.starttls(context=ssl.create_default_context())
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_pass)
        report("Email (SMTP)", "OK", f"{s.smtp_host}:{s.smtp_port} as {s.smtp_user or 'anonymous'}")
    except Exception as e:  # noqa: BLE001
        report("Email (SMTP)", "FAILED", f"{s.smtp_host}: {type(e).__name__}: {str(e)[:120]}")


async def check_razorpay(s) -> None:
    if not (s.razorpay_key_id and s.razorpay_key_secret):
        report("Razorpay (payments)", "NOT SET", "checkout offers cash on delivery + demo OTP payment")
        return
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get("https://api.razorpay.com/v1/orders?count=1", auth=(s.razorpay_key_id, s.razorpay_key_secret))
        mode = "LIVE" if s.razorpay_key_id.startswith("rzp_live") else "test"
        report("Razorpay (payments)", "OK" if res.status_code == 200 else "FAILED", f"{mode} mode · HTTP {res.status_code}")
    except httpx.HTTPError as e:
        report("Razorpay (payments)", "FAILED", f"{type(e).__name__}")


async def check_twilio(s) -> None:
    if not (s.twilio_account_sid and s.twilio_auth_token):
        report("Twilio (SMS / WhatsApp)", "NOT SET", "mobile OTPs are shown on screen in development")
        return
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(
                f"https://api.twilio.com/2010-04-01/Accounts/{s.twilio_account_sid}.json", auth=(s.twilio_account_sid, s.twilio_auth_token)
            )
        senders = ", ".join(x for x in [s.twilio_sms_from and "SMS", s.twilio_whatsapp_from and "WhatsApp"] if x) or "no sender numbers set"
        report("Twilio (SMS / WhatsApp)", "OK" if res.status_code == 200 else "FAILED", f"HTTP {res.status_code} · {senders}")
    except httpx.HTTPError as e:
        report("Twilio (SMS / WhatsApp)", "FAILED", f"{type(e).__name__}")


async def main() -> int:
    s = get_settings()
    await asyncio.gather(check_postgres(s), check_mongo(s), check_razorpay(s), check_twilio(s))
    await asyncio.to_thread(check_s3, s)
    await asyncio.to_thread(check_smtp, s)
    if not s.data_encryption_key:
        report("Data encryption key", "NOT SET" if not s.is_production else "FAILED", "development uses a key derived from JWT_SECRET")
    else:
        report("Data encryption key", "OK", "seller bank details encrypted with DATA_ENCRYPTION_KEY")
    width = max(len(n) for n, _, _ in RESULTS)
    for name, status, detail in RESULTS:
        print(f"{name.ljust(width)}  {status.ljust(8)}  {detail}")
    return 1 if any(status == "FAILED" for _, status, _ in RESULTS) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
