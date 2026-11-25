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
MAX_PER_HOUR = 5  # codes to one email or phone per hour, whatever the purpose: no flooding someone's inbox or phone
CHANNEL_LABEL = {"email": "Email", "sms": "SMS", "whatsapp": "WhatsApp"}
PURPOSE_TEXT = {
    "signup": "verify your email and finish creating your Arvixa Store account",
    "login": "log in to your Arvixa Store account",
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


def sent_response(target: str, channel: str) -> dict:
    """What the caller is told after a code is sent; also returned, without sending, for an unknown account so the
    reply never reveals whether an email or number has an account."""
    return {"sentTo": mask(target), "channel": channel, "expiresInSeconds": get_settings().otp_ttl_minutes * 60}


async def send_code(purpose: str, target: str, channel: str, user_id: int | None = None, payload: dict | None = None) -> dict:
    settings = get_settings()
    if not _configured(channel) and settings.is_production:
        # Never pretend: in production an unconnected channel is refused, not logged and reported as sent
        raise ApiError(503, f"{CHANNEL_LABEL.get(channel, channel)} codes aren't available right now. Please choose another way.")
    pool = get_pool()
    recent = await pool.fetchval(
        "SELECT COUNT(*) FROM verification_codes WHERE target = $1 AND created_at > NOW() - INTERVAL '1 hour'", target
    )
    if recent >= MAX_PER_HOUR:
        raise ApiError(429, "Too many codes sent to this address. Please try again in an hour.")
    age = await pool.fetchval(
        """SELECT EXTRACT(EPOCH FROM NOW() - created_at) FROM verification_codes
            WHERE purpose = $1 AND target = $2 ORDER BY created_at DESC LIMIT 1""",
        purpose,
        target,
    )
    if age is not None and float(age) < RESEND_AFTER_SECONDS:
        raise ApiError(429, f"Please wait {math.ceil(RESEND_AFTER_SECONDS - float(age))} seconds before requesting a new code")

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
    expiry = f"It expires in {settings.otp_ttl_minutes} minutes. Never share it with anyone."
    text = f"{code} is your Arvixa Store verification code to {why}. {expiry}"
    if channel == "email":
        try:
            await mailer.send_mail(
                to=target,
                subject=f"{code} is your Arvixa Store verification code",
                text=text,
                html=f"<p>Use this code to {why}:</p><p style='font-size:28px;letter-spacing:6px;font-weight:bold'>{code}</p>"
                f"<p>It expires in {settings.otp_ttl_minutes} minutes. Never share it with anyone, including Arvixa staff.</p>",
            )
        except OSError:
            raise ApiError(502, "We couldn't send the verification email. Please try again in a minute.") from None
    else:
        await messaging.send(channel, target, text)

    response = sent_response(target, channel)
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
