"""One-time codes that confirm online (UPI / card) payments. Codes are stored only as an HMAC."""

import hashlib
import hmac
import math
import secrets

from ..core.config import get_settings
from ..core.errors import ApiError
from ..db.postgres import get_pool

MAX_ATTEMPTS = 5
RESEND_AFTER_SECONDS = 30


def _hash(code: str) -> str:
    return hmac.new(get_settings().jwt_secret.encode(), code.encode(), hashlib.sha256).hexdigest()


async def create_payment_otp(user_id: int) -> str:
    pool = get_pool()
    age = await pool.fetchval(
        "SELECT EXTRACT(EPOCH FROM NOW() - created_at) FROM payment_otps WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        user_id,
    )
    if age is not None and float(age) < RESEND_AFTER_SECONDS:
        raise ApiError(429, f"Please wait {math.ceil(RESEND_AFTER_SECONDS - float(age))} seconds before requesting a new code")

    code = f"{secrets.randbelow(1_000_000):06d}"
    async with pool.acquire() as conn, conn.transaction():
        # A new code replaces any earlier unused one
        await conn.execute("UPDATE payment_otps SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL", user_id)
        await conn.execute(
            "INSERT INTO payment_otps (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))",
            user_id,
            _hash(code),
            get_settings().otp_ttl_minutes,
        )
    return code


async def verify_payment_otp(user_id: int, code: str | None) -> None:
    """Consumes the user's latest code on success; raises a 400 with a helpful message otherwise."""
    code = str(code or "")
    if not (len(code) == 6 and code.isdigit()):
        raise ApiError(400, "Please enter the 6-digit code sent to your email")

    pool = get_pool()
    otp = await pool.fetchrow(
        "SELECT *, expires_at < NOW() AS expired FROM payment_otps WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
        user_id,
    )
    if not otp:
        raise ApiError(400, "No active code. Please request a new one.")
    if otp["expired"]:
        raise ApiError(400, "This code has expired. Please request a new one.")
    if otp["attempts"] >= MAX_ATTEMPTS:
        raise ApiError(400, "Too many wrong attempts. Please request a new code.")

    if not hmac.compare_digest(otp["code_hash"], _hash(code)):
        await pool.execute("UPDATE payment_otps SET attempts = attempts + 1 WHERE id = $1", otp["id"])
        left = MAX_ATTEMPTS - otp["attempts"] - 1
        raise ApiError(
            400,
            f"Incorrect code. {left} attempt{'' if left == 1 else 's'} left."
            if left > 0
            else "Too many wrong attempts. Please request a new code.",
        )
    await pool.execute("UPDATE payment_otps SET used_at = NOW() WHERE id = $1", otp["id"])
