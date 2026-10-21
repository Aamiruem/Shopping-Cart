"""Password hashing (bcrypt - compatible with hashes made by the old Node API) and JWTs."""

import time

import bcrypt
import jwt

from .config import get_settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        return bcrypt.checkpw(password.encode()[:72], password_hash.encode())
    except ValueError:
        return False


def create_token(user: dict) -> str:
    settings = get_settings()
    now = int(time.time())
    payload = {"id": user["id"], "email": user["email"], "role": user["role"], "iat": now, "exp": now + settings.jwt_expires_seconds}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict:
    """Raises jwt.PyJWTError when the token is invalid or expired."""
    return jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
