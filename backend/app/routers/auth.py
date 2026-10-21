"""/api/auth - email + password accounts, Google sign-in, profile and password."""

import asyncio

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..core.security import create_token, hash_password, verify_password
from ..db.postgres import get_pool
from ..deps import CurrentUser, get_current_user
from ..services import validation as v

router = APIRouter(prefix="/api/auth", tags=["auth"])
auth_limiter = rate_limit(20, message="Too many login attempts. Please try again in 15 minutes.")


class RegisterIn(BaseModel):
    name: str = ""
    email: str = ""
    password: str = ""
    phone: str | None = None


class LoginIn(BaseModel):
    email: str = ""
    password: str = ""


class GoogleIn(BaseModel):
    credential: str = ""


class ProfileIn(BaseModel):
    name: str = ""
    phone: str | None = None


class PasswordIn(BaseModel):
    currentPassword: str = ""
    newPassword: str = ""


async def _store_name(user_id: int) -> str | None:
    return await get_pool().fetchval("SELECT store_name FROM sellers WHERE user_id = $1", user_id)


async def public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "name": u["name"],
        "email": u["email"],
        "phone": u["phone"],
        "role": u["role"],
        "emailVerified": u["email_verified"],
        "hasPassword": bool(u["password_hash"]),
        "googleLinked": bool(u["google_id"]),
        "storeName": await _store_name(u["id"]) if u["role"] in ("seller", "admin") else None,
        "createdAt": u["created_at"],
    }


async def session(u: dict) -> dict:
    return {"token": create_token(u), "user": await public_user(u)}


async def _find_user(user_id: int) -> dict:
    u = await get_pool().fetchrow("SELECT * FROM users WHERE id = $1", user_id)
    if not u:
        raise ApiError(404, "User not found")
    return dict(u)


@router.get("/config")
async def config():
    """Tells the frontend which sign-in options are enabled."""
    return {"googleClientId": get_settings().google_client_id or None}


@router.post("/register", status_code=201, dependencies=[Depends(auth_limiter)])
async def register(body: RegisterIn):
    name = body.name.strip()
    email = v.normalize_email(body.email)
    phone = body.phone.strip() if body.phone else None
    error = v.first_error(v.name_error(name), v.email_error(email), v.phone_error(phone), v.password_error(body.password))
    error = error or await v.email_domain_error(email)
    if error:
        raise ApiError(400, error)

    pool = get_pool()
    existing = await pool.fetchrow("SELECT google_id FROM users WHERE email = $1", email)
    if existing:
        raise ApiError(
            409,
            "This email is registered with Google. Please use “Continue with Google”."
            if existing["google_id"]
            else "An account with this email already exists. Please log in.",
        )

    u = await pool.fetchrow(
        "INSERT INTO users (name, email, phone, password_hash, last_login) VALUES ($1, $2, $3, $4, NOW()) RETURNING *",
        name,
        email,
        phone,
        await asyncio.to_thread(hash_password, body.password),
    )
    return await session(dict(u))


@router.post("/login", dependencies=[Depends(auth_limiter)])
async def login(body: LoginIn):
    email = v.normalize_email(body.email)
    if v.email_error(email) or not body.password:
        raise ApiError(400, "Please enter your email and password")

    pool = get_pool()
    u = await pool.fetchrow("SELECT * FROM users WHERE email = $1", email)
    if u and not u["password_hash"]:
        raise ApiError(400, "This account uses Google sign-in. Please use “Continue with Google”.")
    if not u or not await asyncio.to_thread(verify_password, body.password, u["password_hash"]):
        raise ApiError(401, "Invalid email or password")
    await pool.execute("UPDATE users SET last_login = NOW() WHERE id = $1", u["id"])
    return await session(dict(u))


def _verify_google_token(credential: str, client_id: str) -> dict:
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    return id_token.verify_oauth2_token(credential, google_requests.Request(), client_id)


@router.post("/google", dependencies=[Depends(auth_limiter)])
async def google(body: GoogleIn, response: Response):
    client_id = get_settings().google_client_id
    if not client_id:
        raise ApiError(501, "Google sign-in is not configured on the server")
    try:
        payload = await asyncio.to_thread(_verify_google_token, body.credential, client_id)
    except Exception:  # noqa: BLE001 - any verification failure is a failed sign-in
        raise ApiError(401, "Google sign-in failed. Please try again.") from None
    if not payload.get("email") or not payload.get("email_verified"):
        raise ApiError(401, "Your Google account email is not verified")

    email = v.normalize_email(payload["email"])
    pool = get_pool()
    existing = await pool.fetchrow(
        "SELECT * FROM users WHERE google_id = $1 OR email = $2 ORDER BY google_id NULLS LAST LIMIT 1", payload["sub"], email
    )
    if existing:
        # Link an existing account (password or Google) to this Google identity; Google has verified the email
        u = await pool.fetchrow(
            "UPDATE users SET google_id = $1, email_verified = TRUE, last_login = NOW() WHERE id = $2 RETURNING *",
            payload["sub"],
            existing["id"],
        )
    else:
        u = await pool.fetchrow(
            "INSERT INTO users (name, email, google_id, email_verified, last_login) VALUES ($1, $2, $3, TRUE, NOW()) RETURNING *",
            payload.get("name") or email.split("@")[0],
            email,
            payload["sub"],
        )
    response.status_code = 200 if existing else 201
    return await session(dict(u))


@router.get("/me")
async def me(user: CurrentUser = Depends(get_current_user)):
    return await public_user(await _find_user(user.id))


@router.put("/me")
async def update_profile(body: ProfileIn, user: CurrentUser = Depends(get_current_user)):
    name = body.name.strip()
    phone = body.phone.strip() if body.phone else None
    error = v.first_error(v.name_error(name), v.phone_error(phone))
    if error:
        raise ApiError(400, error)
    u = await get_pool().fetchrow("UPDATE users SET name = $1, phone = $2 WHERE id = $3 RETURNING *", name, phone, user.id)
    if not u:
        raise ApiError(404, "User not found")
    return await public_user(dict(u))


@router.put("/password", dependencies=[Depends(auth_limiter)])
async def change_password(body: PasswordIn, user: CurrentUser = Depends(get_current_user)):
    """Google-only accounts have no current password and may set one directly."""
    error = v.password_error(body.newPassword)
    if error:
        raise ApiError(400, error)
    u = await _find_user(user.id)
    if u["password_hash"] and not await asyncio.to_thread(verify_password, body.currentPassword, u["password_hash"]):
        raise ApiError(400, "Current password is incorrect")
    updated = await get_pool().fetchrow(
        "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *", await asyncio.to_thread(hash_password, body.newPassword), user.id
    )
    return await public_user(dict(updated))
