"""/api/orders - checkout (one SQL transaction), payment OTPs, history and cancellation."""

import logging
import re
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..db.mongo import get_db
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user
from ..services import events, mailer
from ..services.cart import load_cart, save_cart, summarize
from ..services.catalog import to_object_id
from ..services.otp import create_payment_otp, verify_payment_otp

router = APIRouter(prefix="/api/orders", tags=["orders"])
log = logging.getLogger("orders")
otp_limiter = rate_limit(10, message="Too many code requests. Please try again in 15 minutes.")

PAYMENT_METHODS = ("cod", "upi", "card")
ONLINE_METHODS = ("upi", "card")  # money moves before delivery, so these need an OTP

ORDERS_SQL = """
  SELECT o.*, COALESCE(json_agg(oi.* ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.user_id = $1"""


class CheckoutIn(BaseModel):
    addressId: int | None = None
    address: str | None = None
    paymentMethod: str = "cod"
    otp: str | None = None


def _format_address(a) -> str:
    return f"{a['name']}, {a['line1']}, {a['city']}, {a['state']} - {a['pincode']}. Phone: {a['phone']}"


def _mask_email(email: str) -> str:
    return re.sub(r"^(.)(.*)(.@.*)$", lambda m: m[1] + "*" * max(len(m[2]), 1) + m[3], email)


def _inr(value: float) -> str:
    # Indian digit grouping: 1,23,456
    whole = f"{round(value):d}"
    head, tail = whole[:-3], whole[-3:]
    head = re.sub(r"(\d)(?=(\d\d)+$)", r"\1,", head)
    return f"₹{head + ',' if head else ''}{tail}"


@router.post("/otp", dependencies=[Depends(otp_limiter)])
async def request_otp(user: CurrentUser = Depends(get_current_user)):
    """Emails a one-time code that confirms an online payment."""
    account = await get_pool().fetchrow("SELECT email, name FROM users WHERE id = $1", user.id)
    if not account:
        raise ApiError(404, "User not found")
    summary = summarize(await load_cart(user.id))
    if not summary["items"]:
        raise ApiError(400, "Your cart is empty")

    settings = get_settings()
    code = await create_payment_otp(user.id)
    amount = _inr(summary["total"])
    try:
        await mailer.send_mail(
            to=account["email"],
            subject=f"{code} is your Arvixa payment code",
            text=f"Hi {account['name']}, use {code} to confirm your payment of {amount}. It expires in {settings.otp_ttl_minutes} minutes. "
            "Never share this code with anyone.",
            html=f"<p>Hi {account['name']},</p><p>Use this code to confirm your payment of <b>{amount}</b>:</p>"
            f'<p style="font-size:28px;letter-spacing:6px;font-weight:bold">{code}</p>'
            f"<p>It expires in {settings.otp_ttl_minutes} minutes. Never share this code with anyone, including Arvixa staff.</p>",
        )
    except OSError:  # SMTP down, bad credentials, network...
        log.exception("could not send payment OTP email")
        raise ApiError(502, "We couldn't send the verification email. Please try again in a minute.") from None
    response = {"sentTo": _mask_email(account["email"]), "expiresInSeconds": settings.otp_ttl_minutes * 60}
    if not mailer.is_configured() and not settings.is_production:
        response["devCode"] = code  # local development without SMTP: lets the flow be tested
    return response


@router.post("", status_code=201)
async def checkout(body: CheckoutIn, user: CurrentUser = Depends(get_current_user)):
    pool = get_pool()
    address = body.address
    if body.addressId:
        record = await pool.fetchrow("SELECT * FROM addresses WHERE id = $1 AND user_id = $2", body.addressId, user.id)
        if not record:
            raise ApiError(404, "Address not found")
        address = _format_address(record)
    if not address or not address.strip():
        raise ApiError(400, "Shipping address is required")
    if body.paymentMethod not in PAYMENT_METHODS:
        raise ApiError(400, "Unsupported payment method")

    lines = await load_cart(user.id)
    summary = summarize(lines)
    if not summary["items"]:
        raise ApiError(400, "Your cart is empty")
    for line in lines:
        if line["product"].get("stock", 0) < line["qty"]:
            raise ApiError(409, f"Only {line['product'].get('stock', 0)} left of {line['product']['name']}")

    if body.paymentMethod in ONLINE_METHODS:
        await verify_payment_otp(user.id, body.otp)
    # TODO: for 'upi' / 'card', charge via a payment gateway (Razorpay / Stripe) before committing

    async with pool.acquire() as conn, conn.transaction():
        order = await conn.fetchrow(
            "INSERT INTO orders (user_id, total, address, payment_method, delivery_fee) VALUES ($1, $2, $3, $4, $5) RETURNING *",
            user.id,
            summary["total"],
            address.strip(),
            body.paymentMethod,
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
    await save_cart(user.id, [])
    now = datetime.now(UTC)
    await events.track_many(
        [
            {
                "type": "purchase",
                "userId": user.id,
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


@router.get("")
async def list_orders(user: CurrentUser = Depends(get_current_user)):
    return rows(await get_pool().fetch(f"{ORDERS_SQL} GROUP BY o.id ORDER BY o.created_at DESC", user.id))


@router.get("/{order_id}")
async def get_order(order_id: int, user: CurrentUser = Depends(get_current_user)):
    record = await get_pool().fetchrow(f"{ORDERS_SQL} AND o.id = $2 GROUP BY o.id", user.id, order_id)
    if not record:
        raise ApiError(404, "Order not found")
    return dict(record)


@router.patch("/{order_id}/cancel")
async def cancel(order_id: int, user: CurrentUser = Depends(get_current_user)):
    """Cancels a placed order and puts the stock back."""
    pool = get_pool()
    order = await pool.fetchrow(
        "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'placed' RETURNING *", order_id, user.id
    )
    if not order:
        raise ApiError(400, "This order cannot be cancelled")
    db = get_db()
    for item in await pool.fetch("SELECT product_id, qty FROM order_items WHERE order_id = $1", order_id):
        if oid := to_object_id(item["product_id"]):
            await db.products.update_one({"_id": oid}, {"$inc": {"stock": item["qty"]}})
    return dict(order)
