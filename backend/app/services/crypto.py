"""Encryption at rest for sensitive fields (seller bank account numbers), using Fernet (AES-128-CBC + HMAC)."""

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from ..core.config import get_settings

PREFIX = "enc:"  # marks encrypted values, so older plain-text rows can still be read and re-saved


@lru_cache
def _fernet(key: str, fallback_secret: str) -> Fernet:
    if key:
        return Fernet(key.encode())
    # Development only (production refuses to start without DATA_ENCRYPTION_KEY)
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(f"data-key:{fallback_secret}".encode()).digest()))


def _cipher() -> Fernet:
    s = get_settings()
    return _fernet(s.data_encryption_key, s.jwt_secret)


def encrypt(value: str | None) -> str | None:
    if not value:
        return None
    return PREFIX + _cipher().encrypt(value.encode()).decode()


def decrypt(value: str | None) -> str | None:
    if not value:
        return None
    if not value.startswith(PREFIX):
        return value  # legacy plain-text row
    try:
        return _cipher().decrypt(value[len(PREFIX) :].encode()).decode()
    except InvalidToken:
        return None  # wrong key: treat as missing rather than crash
