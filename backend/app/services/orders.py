"""Placing orders: shared by cash-on-delivery checkout and verified online payments."""

import logging
from datetime import UTC, datetime

from ..core.cache import invalidate
from ..core.errors import ApiError
from ..db.mongo import get_db
from ..db.postgres import get_pool
from . import events, mailer
from .cart import load_cart, save_cart, summarize

log = logging.getLogger("orders")

# Every way an order can be paid. cod = cash on delivery; the rest are online (Razorpay, or the dev-only OTP demo).
PAYMENT_METHODS = ("cod", "upi", "card", "netbanking", "wallet", "emi")
FULFILMENT_STEPS = ("pending", "packed", "shipped", "delivered")


def _options(item: dict) -> dict | None:
    """Size / colour of a clothing line (the asyncpg codec stores the dict as jsonb)."""
    return {k: item[k] for k in ("size", "color") if item.get(k)} or None


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


async def add_event(connection, order_id: int, status: str, note: str | None = None) -> None:
    """One line of the order's timeline. `connection` is the pool or the open transaction."""
    await connection.execute("INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)", order_id, status, note)


async def _reserve_stock(lines: list[dict]) -> None:
    """Takes the stock atomically, so two shoppers can never both buy the last one."""
    db = get_db()
    taken: list[dict] = []
    for line in lines:
        result = await db.products.update_one(
            {"_id": line["product"]["_id"], "stock": {"$gte": line["qty"]}}, {"$inc": {"stock": -line["qty"]}}
        )
        if not result.modified_count:
            await release_stock(taken)
            raise ApiError(409, f"Sorry, {line['product']['name']} has just sold out")
        taken.append(line)


async def release_stock(lines: list[dict]) -> None:
    db = get_db()
    for line in lines:
        await db.products.update_one({"_id": line["product"]["_id"]}, {"$inc": {"stock": line["qty"]}})


async def _send_confirmation(user_id: int, order_id: int, total: float) -> None:
    """Order emails must never fail the order itself: the shopper has already paid."""
    try:
        account = await get_pool().fetchrow("SELECT name, email FROM users WHERE id = $1", user_id)
        await mailer.send_mail(
            to=account["email"],
            subject=f"Your Arvixa Store order #{order_id} is confirmed",
            text=f"Hi {account['name']}, we have received your order #{order_id} for ₹{round(total):,}. We'll email you when it ships.",
        )
    except Exception:
        log.exception("could not send the confirmation email for order %s", order_id)


async def place_order(
    user_id: int, address: str, payment_method: str, lines: list[dict] | None = None, summary: dict | None = None
) -> dict:
    """Writes the order (one SQL transaction), takes the stock, empties the cart and logs purchase events."""
    if payment_method not in PAYMENT_METHODS:
        raise ApiError(400, "Unsupported payment method")
    if lines is None or summary is None:
        lines, summary = await checkout_summary(user_id)

    await _reserve_stock(lines)
    pool = get_pool()
    try:
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
                """INSERT INTO order_items (order_id, product_id, name, price, qty, image, seller_id, category, options)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)""",
                [
                    (order["id"], i["productId"], i["name"], i["price"], i["qty"], i["image"], i["sellerId"], i["category"], _options(i))
                    for i in summary["items"]
                ],
            )
            await add_event(conn, order["id"], "placed", "Order placed")
    except Exception:
        await release_stock(lines)
        raise

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
    await _send_confirmation(user_id, order["id"], float(summary["total"]))
    return {**dict(order), "items": summary["items"]}
