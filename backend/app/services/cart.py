"""Cart storage (MongoDB) and the price breakdown shown on cart / checkout."""

from ..db.mongo import get_db

MAX_QTY = 10  # per line, like most marketplaces
FREE_DELIVERY_ABOVE = 499
DELIVERY_FEE = 40


async def load_cart(user_id: int) -> list[dict]:
    """Returns cart lines as [{"product": <product doc>, "qty": n}], dropping deleted / unlisted products."""
    db = get_db()
    cart = await db.carts.find_one({"userId": user_id}) or {"items": []}
    ids = [i["product"] for i in cart["items"]]
    products = {p["_id"]: p async for p in db.products.find({"_id": {"$in": ids}, "active": {"$ne": False}})}
    return [{"product": products[i["product"]], "qty": i["qty"]} for i in cart["items"] if i["product"] in products]


async def save_cart(user_id: int, lines: list[dict]) -> None:
    items = [{"product": line["product"]["_id"], "qty": line["qty"]} for line in lines]
    await get_db().carts.update_one({"userId": user_id}, {"$set": {"items": items}}, upsert=True)


def summarize(lines: list[dict]) -> dict:
    items = []
    for line in lines:
        p = line["product"]
        mrp = p["mrp"] if p.get("mrp") and p["mrp"] > p["price"] else p["price"]
        items.append(
            {
                "productId": str(p["_id"]),
                "name": p["name"],
                "brand": p.get("brand", ""),
                "image": p.get("image"),
                "category": p.get("category"),
                "sellerId": p.get("sellerId"),
                "price": p["price"],
                "mrp": mrp,
                "stock": p.get("stock", 0),
                "qty": line["qty"],
                "subtotal": p["price"] * line["qty"],
            }
        )
    total_mrp = sum(i["mrp"] * i["qty"] for i in items)
    subtotal = sum(i["subtotal"] for i in items)
    delivery_fee = 0 if not items or subtotal >= FREE_DELIVERY_ABOVE else DELIVERY_FEE
    return {
        "items": items,
        "totalMrp": total_mrp,
        "discount": total_mrp - subtotal,
        "subtotal": subtotal,
        "deliveryFee": delivery_fee,
        "total": subtotal + delivery_fee,
    }


def clamp_qty(qty, stock: int) -> int:
    try:
        qty = int(float(qty))
    except (TypeError, ValueError):
        qty = 1
    return max(1, min(qty, MAX_QTY, stock))
