"""Authentication: verifies the backend's login tokens (HS256 JWT, shared JWT_SECRET).

The backend forwards the shopper's or seller's `Authorization: Bearer <token>` header unchanged, so the AI
service knows exactly who is asking - and a seller's analytics questions only ever see that seller's sales.
"""

from dataclasses import dataclass

import jwt
from fastapi import Depends, Header, HTTPException

from .config import get_settings


@dataclass(frozen=True)
class User:
    id: int
    email: str
    role: str  # customer | seller | admin

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def current_user(authorization: str = Header(default="")) -> User:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Please log in")
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
        return User(id=int(claims["id"]), email=claims.get("email", ""), role=claims.get("role", "customer"))
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise HTTPException(401, "Your session has expired. Please log in again.") from None


def require_seller(user: User = Depends(current_user)) -> User:
    if user.role not in ("seller", "admin"):
        raise HTTPException(403, "Seller account required")
    return user


def seller_scope(user: User, seller_id: int | None = None) -> int | None:
    """Which seller's data a request may see: sellers always their own; admins anyone's, or all (None)."""
    return (seller_id or None) if user.is_admin else user.id
