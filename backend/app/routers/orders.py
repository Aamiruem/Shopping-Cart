"""/api/orders - checkout, payment OTPs (dev demo), history and cancellation (with refunds for online payments)."""

import logging
import re
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.cache import invalidate
from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..db.mongo import get_db
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user, require_admin
from ..services import mailer, razorpay
from ..services.cart import load_cart, summarize
from ..services.catalog import to_object_id
from ..services.orders import add_event, checkout_summary, place_order, resolve_address
from ..services.otp import create_payment_otp, verify_payment_otp

router = APIRouter(prefix="/api/orders", tags=["orders"])
log = logging.getLogger("orders")
otp_limiter = rate_limit(10, message="Too many code requests. Please try again in 15 minutes.")

# Dev-only demo of online payment: an emailed OTP stands in for the gateway when Razorpay keys are not set.
# Production refuses it: an order marked as paid must always have real money behind it.
OTP_DEMO_METHODS = ("upi", "card")
RETURN_WINDOW_DAYS = 7

ORDERS_SQL = """
  SELECT o.*, COALESCE(json_agg(oi.* ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.user_id = $1"""


class CheckoutIn(BaseModel):
    addressId: int | None = None
    address: str | None = None
    paymentMethod: str = "cod"
    otp: str | None = None


class ReturnIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class ReturnDecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=300)


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
            subject=f"{code} is your Arvixa Store payment code",
            text=f"Hi {account['name']}, use {code} to confirm your payment of {amount}. It expires in {settings.otp_ttl_minutes} minutes. "
            "Never share this code with anyone.",
            html=f"<p>Hi {account['name']},</p><p>Use this code to confirm your payment of <b>{amount}</b>:</p>"
            f'<p style="font-size:28px;letter-spacing:6px;font-weight:bold">{code}</p>'
            f"<p>It expires in {settings.otp_ttl_minutes} minutes. Never share this code with anyone, including Arvixa Store staff.</p>",
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
    """Cash on delivery, or (development without Razorpay keys) the OTP payment demo.
    Real online payments go through /api/payments/razorpay/* instead."""
    address = await resolve_address(user.id, body.addressId, body.address)
    if body.paymentMethod != "cod":
        if body.paymentMethod not in OTP_DEMO_METHODS:
            raise ApiError(400, "Unsupported payment method")
        if razorpay.is_configured():
            raise ApiError(400, "Please pay online with UPI, net banking or a card")
        if get_settings().is_production:
            raise ApiError(503, "Online payments are not available right now. Please choose cash on delivery.")
    lines, summary = await checkout_summary(user.id)
    if body.paymentMethod in OTP_DEMO_METHODS:
        await verify_payment_otp(user.id, body.otp)
    return await place_order(user.id, address, body.paymentMethod, lines, summary)


@router.get("")
async def list_orders(user: CurrentUser = Depends(get_current_user)):
    return rows(await get_pool().fetch(f"{ORDERS_SQL} GROUP BY o.id ORDER BY o.created_at DESC", user.id))


@router.get("/{order_id}")
async def get_order(order_id: int, user: CurrentUser = Depends(get_current_user)):
    pool = get_pool()
    record = await pool.fetchrow(f"{ORDERS_SQL} AND o.id = $2 GROUP BY o.id", user.id, order_id)
    if not record:
        raise ApiError(404, "Order not found")
    events = await pool.fetch("SELECT status, note, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at, id", order_id)
    return_request = await pool.fetchrow("SELECT status, refund, reason, created_at FROM order_returns WHERE order_id = $1", order_id)
    return {**dict(record), "events": rows(events), "return": dict(return_request) if return_request else None}


@router.patch("/{order_id}/cancel")
async def cancel(order_id: int, user: CurrentUser = Depends(get_current_user)):
    """Cancels an order that has not shipped yet, puts the stock back and refunds online payments."""
    pool = get_pool()
    if await pool.fetchval("SELECT 1 FROM order_items WHERE order_id = $1 AND fulfilment IN ('shipped', 'delivered')", order_id):
        raise ApiError(400, "This order has already shipped, so it can't be cancelled. You can return it after delivery.")
    order = await pool.fetchrow(
        "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'placed' RETURNING *", order_id, user.id
    )
    if not order:
        raise ApiError(400, "This order cannot be cancelled")
    await add_event(pool, order_id, "cancelled", "Cancelled by you")
    await _return_stock(order_id)
    return {**dict(order), "refund": await _refund_order(order_id)}


async def _return_stock(order_id: int) -> None:
    db = get_db()
    for item in await get_pool().fetch("SELECT product_id, qty FROM order_items WHERE order_id = $1", order_id):
        if oid := to_object_id(item["product_id"]):
            await db.products.update_one({"_id": oid}, {"$inc": {"stock": item["qty"]}})
    invalidate("catalog:")


async def _refund_order(order_id: int) -> str | None:
    """Refunds an online payment in full. None when nothing was paid online (cash on delivery)."""
    pool = get_pool()
    payment = await pool.fetchrow("SELECT * FROM payments WHERE order_id = $1 AND status = 'paid'", order_id)
    if not payment:
        return None
    try:
        await razorpay.refund(payment["provider_payment_id"])
        status = "refunded"
    except ApiError:
        log.exception("refund failed for payment %s", payment["id"])
        status = "refund_pending"  # retried from the Razorpay dashboard; the shopper is told it is on its way
    await pool.execute("UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2", status, payment["id"])
    return status


@router.post("/{order_id}/return", status_code=201)
async def request_return(order_id: int, body: ReturnIn, user: CurrentUser = Depends(get_current_user)):
    """Starts a return for a delivered order, within the return window."""
    pool = get_pool()
    order = await pool.fetchrow("SELECT status FROM orders WHERE id = $1 AND user_id = $2", order_id, user.id)
    if not order:
        raise ApiError(404, "Order not found")
    delivery = await pool.fetchrow(
        """SELECT BOOL_AND(fulfilment = 'delivered') AS delivered, MAX(fulfilled_at) AS delivered_at
             FROM order_items WHERE order_id = $1""",
        order_id,
    )
    if order["status"] != "placed" or not delivery["delivered"]:
        raise ApiError(400, "You can return an order once it has been delivered")
    if delivery["delivered_at"] and datetime.now(UTC) - delivery["delivered_at"] > timedelta(days=RETURN_WINDOW_DAYS):
        raise ApiError(400, f"The {RETURN_WINDOW_DAYS}-day return window for this order has closed")
    created = await pool.fetchrow(
        """INSERT INTO order_returns (order_id, user_id, reason) VALUES ($1, $2, $3)
           ON CONFLICT (order_id) DO NOTHING RETURNING *""",
        order_id,
        user.id,
        body.reason.strip(),
    )
    if not created:
        raise ApiError(409, "A return has already been requested for this order")
    await add_event(pool, order_id, "return_requested", "Return requested")
    return dict(created)


@router.get("/returns/pending", dependencies=[Depends(require_admin)])
async def pending_returns():
    return rows(
        await get_pool().fetch(
            """SELECT r.*, o.total, o.payment_method, u.name AS customer
                 FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = r.user_id
                WHERE r.status = 'requested' ORDER BY r.created_at"""
        )
    )


@router.patch("/{order_id}/return", dependencies=[Depends(require_admin)])
async def resolve_return(order_id: int, body: ReturnDecisionIn):
    """Approving takes the stock back and refunds an online payment. Cash orders are refunded by hand."""
    pool = get_pool()
    status = "approved" if body.approve else "rejected"
    claimed = await pool.fetchrow(
        "UPDATE order_returns SET status = $1, resolved_at = NOW() WHERE order_id = $2 AND status = 'requested' RETURNING *",
        status,
        order_id,
    )
    if not claimed:
        raise ApiError(404, "No open return for this order")
    if not body.approve:
        await add_event(pool, order_id, "return_rejected", body.note or "Return not approved")
        return dict(claimed)

    await pool.execute("UPDATE orders SET status = 'returned' WHERE id = $1", order_id)
    await _return_stock(order_id)
    refund = await _refund_order(order_id) or "cod_manual"
    await pool.execute("UPDATE order_returns SET refund = $1 WHERE order_id = $2", refund, order_id)
    await add_event(pool, order_id, "returned", "Return approved")
    return {**dict(claimed), "refund": refund}
