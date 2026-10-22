"""Placing orders: shared by cash-on-delivery checkout and verified online payments."""

from datetime import UTC, datetime

from ..core.cache import invalidate
from ..core.errors import ApiError
from ..db.mongo import get_db
from ..db.postgres import get_pool
from . import events
from .cart import load_cart, save_cart, summarize

# Every way an order can be paid. cod = cash on delivery; the rest are online (Razorpay, or the dev-only OTP demo).
PAYMENT_METHODS = ("cod", "upi", "card", "netbanking", "wallet", "emi")
FULFILMENT_STEPS = ("pending", "packed", "shipped", "delivered")


def format_address(a) -> str:
    return f"{a['name']}, {a['line1']}, {a['city']}, {a['state']} - {a['pincode']}. Phone: {a['phone']}"


async def resolve_address(user_id: int, address_id: int | None, address: str | None) -> str:
    if address_id:
        record = await get_pool().fetchrow("SELECT * FROM addresses WHERE id = $1 AND user_id = $2", address_id, user_id)
        if not record:
            raise ApiError(404, "Address not found")
        address = format_address(record)
    if not address or not address.strip():
        raise ApiError(400, "Shipping address is required")
    return address.strip()


async def checkout_summary(user_id: int) -> tuple[list[dict], dict]:
    """The cart and its price breakdown, after checking it is not empty and everything is in stock."""
    lines = await load_cart(user_id)
    summary = summarize(lines)
    if not summary["items"]:
        raise ApiError(400, "Your cart is empty")
    for line in lines:
        if line["product"].get("stock", 0) < line["qty"]:
            raise ApiError(409, f"Only {line['product'].get('stock', 0)} left of {line['product']['name']}")
    return lines, summary


async def place_order(
    user_id: int, address: str, payment_method: str, lines: list[dict] | None = None, summary: dict | None = None
) -> dict:
    """Writes the order (one SQL transaction), takes the stock, empties the cart and logs purchase events."""
    if payment_method not in PAYMENT_METHODS:
        raise ApiError(400, "Unsupported payment method")
    if lines is None or summary is None:
        lines, summary = await checkout_summary(user_id)

    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        order = await conn.fetchrow(
            "INSERT INTO orders (user_id, total, address, payment_method, delivery_fee) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            user_id,
            summary["total"],
            address,
            payment_method,
            summary["deliveryFee"],
        )
        await conn.executemany(
            """INSERT INTO order_items (order_id, product_id, name, price, qty, image, seller_id, category)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            [
                (order["id"], i["productId"], i["name"], i["price"], i["qty"], i["image"], i["sellerId"], i["category"])
                for i in summary["items"]
            ],
        )

    db = get_db()
    for line in lines:
        await db.products.update_one({"_id": line["product"]["_id"]}, {"$inc": {"stock": -line["qty"]}})
    await save_cart(user_id, [])
    invalidate("catalog:")  # stock changed
    now = datetime.now(UTC)
    await events.track_many(
        [
            {
                "type": "purchase",
                "userId": user_id,
                "productId": i["productId"],
                "category": i["category"],
                "sellerId": i["sellerId"],
                "price": i["price"],
                "qty": i["qty"],
                "orderId": order["id"],
                "ts": now,
            }
            for i in summary["items"]
        ]
    )
    return {**dict(order), "items": summary["items"]}
