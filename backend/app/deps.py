"""Request dependencies: who is calling, and are they allowed to."""

from dataclasses import dataclass

import jwt
from fastapi import Depends, Request

from .core.errors import ApiError
from .core.security import decode_token
from .db.postgres import get_pool


@dataclass
class CurrentUser:
    id: int
    email: str
    role: str  # customer | seller | admin

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    return header[7:] if header.startswith("Bearer ") else None


def get_current_user(request: Request) -> CurrentUser:
    token = _bearer(request)
    if not token:
        raise ApiError(401, "Login required")
    try:
        payload = decode_token(token)
    except jwt.PyJWTError:
        raise ApiError(401, "Invalid or expired token") from None
    return CurrentUser(id=payload["id"], email=payload["email"], role=payload.get("role", "customer"))


def get_optional_user(request: Request) -> CurrentUser | None:
    """Like get_current_user, but guests (or bad tokens) get None instead of a 401."""
    try:
        return get_current_user(request) if _bearer(request) else None
    except ApiError:
        return None


async def _role_from_db(user: CurrentUser) -> CurrentUser:
    # Roles change (customer -> seller, or an admin revokes access), so check the database, not the token
    role = await get_pool().fetchval("SELECT role FROM users WHERE id = $1", user.id)
    if role is None:
        raise ApiError(401, "Account not found")
    user.role = role
    return user


async def require_seller(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    user = await _role_from_db(user)
    if user.role not in ("seller", "admin"):
        raise ApiError(403, "Seller account required")
    return user


async def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    user = await _role_from_db(user)
    if not user.is_admin:
        raise ApiError(403, "Admins only")
    return user
