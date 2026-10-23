"""/api/cart - the shopper's cart (MongoDB) with a full price breakdown."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser, get_current_user
from ..services import events
from ..services.cart import clamp_qty, line_id, load_cart, save_cart, summarize
from ..services.catalog import to_object_id

router = APIRouter(prefix="/api/cart", tags=["cart"])


class AddIn(BaseModel):
    productId: str = ""
    qty: float = 1
    size: str | None = None
    color: str | None = None


class QtyIn(BaseModel):
    qty: float = 0


def _find_line(lines: list[dict], key: str) -> dict | None:
    """key = a cart line id (product~size~colour) or, for plain products, the product id."""
    return next((line for line in lines if line_id(line["product"]["_id"], line.get("size"), line.get("color")) == key), None)


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

    size = (body.size or "").strip() or None
    color = (body.color or "").strip() or None
    if product.get("sizes"):
        if not size:
            raise ApiError(400, "Please select a size")
        if size not in product["sizes"]:
            raise ApiError(400, f"Size {size} is not available")
    else:
        size = None
    if product.get("colors"):
        if color and color not in product["colors"]:
            raise ApiError(400, f"Colour {color} is not available")
        color = color or product["colors"][0]
    else:
        color = None

    lines = await load_cart(user.id)
    line = _find_line(lines, line_id(oid, size, color))
    if line:
        line["qty"] = clamp_qty(line["qty"] + body.qty, product["stock"])
    else:
        lines.append({"product": product, "qty": clamp_qty(body.qty, product["stock"]), "size": size, "color": color})
    await save_cart(user.id, lines)
    await events.track("add_to_cart", product, user.id, int(body.qty) or 1)
    return summarize(await load_cart(user.id))


@router.put("/{line_key}")
async def update(line_key: str, body: QtyIn, user: CurrentUser = Depends(get_current_user)):
    """qty 0 removes the line. line_key = the item's lineId (its productId for products without sizes)."""
    lines = await load_cart(user.id)
    line = _find_line(lines, line_key)
    if not line:
        raise ApiError(404, "Item not in cart")
    if body.qty <= 0:
        lines.remove(line)
    else:
        line["qty"] = clamp_qty(body.qty, line["product"].get("stock", 0))
    await save_cart(user.id, lines)
    return summarize(await load_cart(user.id))


@router.delete("/{line_key}")
async def remove(line_key: str, user: CurrentUser = Depends(get_current_user)):
    lines = [line for line in await load_cart(user.id) if line_id(line["product"]["_id"], line.get("size"), line.get("color")) != line_key]
    await save_cart(user.id, lines)
    return summarize(lines)
