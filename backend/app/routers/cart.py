"""/api/cart - the shopper's cart (MongoDB) with a full price breakdown."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser, get_current_user
from ..services import events
from ..services.cart import clamp_qty, load_cart, save_cart, summarize
from ..services.catalog import to_object_id

router = APIRouter(prefix="/api/cart", tags=["cart"])


class AddIn(BaseModel):
    productId: str = ""
    qty: float = 1


class QtyIn(BaseModel):
    qty: float = 0


def _find_line(lines: list[dict], product_id: str) -> dict | None:
    return next((line for line in lines if str(line["product"]["_id"]) == product_id), None)


@router.get("")
async def get_cart(user: CurrentUser = Depends(get_current_user)):
    return summarize(await load_cart(user.id))


@router.post("", status_code=201)
async def add(body: AddIn, user: CurrentUser = Depends(get_current_user)):
    oid = to_object_id(body.productId)
    product = await get_db().products.find_one({"_id": oid, "active": {"$ne": False}}) if oid else None
    if not product:
        raise ApiError(404, "Product not found")
    if product.get("stock", 0) < 1:
        raise ApiError(409, f"{product['name']} is out of stock")

    lines = await load_cart(user.id)
    line = _find_line(lines, str(oid))
    if line:
        line["qty"] = clamp_qty(line["qty"] + body.qty, product["stock"])
    else:
        lines.append({"product": product, "qty": clamp_qty(body.qty, product["stock"])})
    await save_cart(user.id, lines)
    await events.track("add_to_cart", product, user.id, int(body.qty) or 1)
    return summarize(await load_cart(user.id))


@router.put("/{product_id}")
async def update(product_id: str, body: QtyIn, user: CurrentUser = Depends(get_current_user)):
    """qty 0 removes the line."""
    lines = await load_cart(user.id)
    line = _find_line(lines, product_id)
    if not line:
        raise ApiError(404, "Item not in cart")
    if body.qty <= 0:
        lines.remove(line)
    else:
        line["qty"] = clamp_qty(body.qty, line["product"].get("stock", 0))
    await save_cart(user.id, lines)
    return summarize(await load_cart(user.id))


@router.delete("/{product_id}")
async def remove(product_id: str, user: CurrentUser = Depends(get_current_user)):
    lines = [line for line in await load_cart(user.id) if str(line["product"]["_id"]) != product_id]
    await save_cart(user.id, lines)
    return summarize(lines)
