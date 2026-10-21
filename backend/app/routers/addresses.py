"""/api/addresses - saved delivery addresses (PostgreSQL)."""

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from ..core.errors import ApiError
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user
from ..services.validation import PHONE_RE, PINCODE_RE

router = APIRouter(prefix="/api/addresses", tags=["addresses"])
FIELDS = ("name", "phone", "line1", "city", "state", "pincode")


class AddressIn(BaseModel):
    name: str = ""
    phone: str = ""
    line1: str = ""
    city: str = ""
    state: str = ""
    pincode: str = ""
    type: str = "home"


def _validate(a: AddressIn) -> str | None:
    for field in FIELDS:
        if not getattr(a, field).strip():
            return f"{'Address' if field == 'line1' else field.capitalize()} is required"
    if not PHONE_RE.match(a.phone.strip()):
        return "Please enter a valid 10-digit mobile number"
    if not PINCODE_RE.match(a.pincode.strip()):
        return "Please enter a valid 6-digit pincode"
    return None


@router.get("")
async def list_addresses(user: CurrentUser = Depends(get_current_user)):
    return rows(await get_pool().fetch("SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC", user.id))


@router.post("", status_code=201)
async def create(body: AddressIn, user: CurrentUser = Depends(get_current_user)):
    if error := _validate(body):
        raise ApiError(400, error)
    values = [getattr(body, f).strip() for f in FIELDS]
    record = await get_pool().fetchrow(
        f"INSERT INTO addresses (user_id, {', '.join(FIELDS)}, type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *",
        user.id,
        *values,
        "work" if body.type == "work" else "home",
    )
    return dict(record)


@router.delete("/{address_id}", status_code=204)
async def remove(address_id: int, user: CurrentUser = Depends(get_current_user)):
    await get_pool().execute("DELETE FROM addresses WHERE id = $1 AND user_id = $2", address_id, user.id)
    return Response(status_code=204)
