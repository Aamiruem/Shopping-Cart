"""One-time verification codes for signup (email), passwordless login (email / SMS / WhatsApp), phone numbers
and payout changes.

Codes are 6 digits, stored only as an HMAC, expire after OTP_TTL_MINUTES, allow 5 attempts and can be
re-sent after 30 seconds. In development, when the channel isn't configured (no SMTP / Twilio), the
code is returned to the caller as `devCode` so the flow can be tested.
"""

import hashlib
import hmac
import json
import math
import re
import secrets

from ..core.config import get_settings
from ..core.errors import ApiError
from ..db.postgres import get_pool
from . import mailer, messaging

MAX_ATTEMPTS = 5
RESEND_AFTER_SECONDS = 30
PURPOSE_TEXT = {
    "signup": "verify your email and finish creating your Arvixa account",
    "login": "log in to your Arvixa account",
    "phone": "verify your mobile number on Arvixa",
    "payout": "confirm the change to your payout account",
}


def _hash(code: str) -> str:
    return hmac.new(get_settings().jwt_secret.encode(), f"verify:{code}".encode(), hashlib.sha256).hexdigest()


def mask(target: str) -> str:
    if "@" in target:
        return re.sub(r"^(.)(.*)(.@.*)$", lambda m: m[1] + "*" * max(len(m[2]), 1) + m[3], target)
    return f"{'*' * max(len(target) - 4, 0)}{target[-4:]}"


def _configured(channel: str) -> bool:
    return mailer.is_configured() if channel == "email" else messaging.is_configured(channel)


async def send_code(purpose: str, target: str, channel: str, user_id: int | None = None, payload: dict | None = None) -> dict:
    pool = get_pool()
    age = await pool.fetchval(
        """SELECT EXTRACT(EPOCH FROM NOW() - created_at) FROM verification_codes
            WHERE purpose = $1 AND target = $2 ORDER BY created_at DESC LIMIT 1""",
        purpose,
        target,
    )
    if age is not None and float(age) < RESEND_AFTER_SECONDS:
        raise ApiError(429, f"Please wait {math.ceil(RESEND_AFTER_SECONDS - float(age))} seconds before requesting a new code")

    settings = get_settings()
    code = f"{secrets.randbelow(1_000_000):06d}"
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "UPDATE verification_codes SET used_at = NOW() WHERE purpose = $1 AND target = $2 AND used_at IS NULL", purpose, target
        )
        await conn.execute(
            """INSERT INTO verification_codes (purpose, target, channel, user_id, payload, code_hash, expires_at)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW() + make_interval(mins => $7))""",
            purpose,
            target,
            channel,
            user_id,
            json.dumps(payload) if payload is not None else None,
            _hash(code),
            settings.otp_ttl_minutes,
        )

    why = PURPOSE_TEXT[purpose]
    text = (
        f"{code} is your Arvixa verification code to {why}. It expires in {settings.otp_ttl_minutes} minutes. Never share it with anyone."
    )
    if channel == "email":
        try:
            await mailer.send_mail(
                to=target,
                subject=f"{code} is your Arvixa verification code",
                text=text,
                html=f"<p>Use this code to {why}:</p><p style='font-size:28px;letter-spacing:6px;font-weight:bold'>{code}</p>"
                f"<p>It expires in {settings.otp_ttl_minutes} minutes. Never share it with anyone, including Arvixa staff.</p>",
            )
        except OSError:
            raise ApiError(502, "We couldn't send the verification email. Please try again in a minute.") from None
    else:
        await messaging.send(channel, target, text)

    response = {"sentTo": mask(target), "channel": channel, "expiresInSeconds": settings.otp_ttl_minutes * 60}
    if not _configured(channel) and not settings.is_production:
        response["devCode"] = code  # local development: the channel isn't connected, so show the code
    return response


async def check_code(purpose: str, target: str, code: str | None) -> dict:
    """Consumes the latest code for (purpose, target); returns its row (user_id, payload) or raises 400."""
    code = str(code or "").strip()
    if not (len(code) == 6 and code.isdigit()):
        raise ApiError(400, "Please enter the 6-digit code")
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT *, expires_at < NOW() AS expired FROM verification_codes
            WHERE purpose = $1 AND target = $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1""",
        purpose,
        target,
    )
    if not row:
        raise ApiError(400, "No active code. Please request a new one.")
    if row["expired"]:
        raise ApiError(400, "This code has expired. Please request a new one.")
    if row["attempts"] >= MAX_ATTEMPTS:
        raise ApiError(400, "Too many wrong attempts. Please request a new code.")
    if not hmac.compare_digest(row["code_hash"], _hash(code)):
        await pool.execute("UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1", row["id"])
        left = MAX_ATTEMPTS - row["attempts"] - 1
        raise ApiError(
            400,
            f"That code is not correct. {left} attempt{'s' if left != 1 else ''} left."
            if left
            else "Too many wrong attempts. Please request a new code.",
        )
    await pool.execute("UPDATE verification_codes SET used_at = NOW() WHERE id = $1", row["id"])
    data = dict(row)
    if isinstance(data.get("payload"), str):
        data["payload"] = json.loads(data["payload"])
    return data
