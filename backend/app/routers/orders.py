"""/api/orders - checkout, payment OTPs (dev demo), history and cancellation (with refunds for online payments)."""

import logging
import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user, require_admin
from ..services import mailer, razorpay
from ..services import returns as return_service
from ..services.cart import load_cart
from ..services.coupons import priced
from ..services.orders import add_event, checkout_summary, place_order, refund_order, resolve_address, return_stock
from ..services.otp import create_payment_otp, verify_payment_otp

router = APIRouter(prefix="/api/orders", tags=["orders"])
log = logging.getLogger("orders")
otp_limiter = rate_limit(10, message="Too many code requests. Please try again in 15 minutes.")

# Dev-only demo of online payment: an emailed OTP stands in for the gateway when Razorpay keys are not set.
# Production refuses it: an order marked as paid must always have real money behind it.
OTP_DEMO_METHODS = ("upi", "card")

ORDERS_SQL = """
  SELECT o.*, COALESCE(json_agg(oi.* ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
         (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
         (SELECT r.refund FROM order_returns r WHERE r.order_id = o.id AND r.status <> 'withdrawn') AS return_refund
    FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
   WHERE o.user_id = $1"""


class CheckoutIn(BaseModel):
    addressId: int | None = None
    address: str | None = None
    paymentMethod: str = "cod"
    otp: str | None = None


class ReturnIn(BaseModel):
    """reasonCode and details; for cash orders, where the refund goes (refundTo upi | bank with its fields).
    The older client sends only `reason`."""

    reasonCode: str | None = None
    details: str | None = Field(default=None, max_length=500)
    reason: str | None = Field(default=None, max_length=500)
    refundTo: str | None = None
    upi: str | None = None
    accountName: str | None = None
    accountNumber: str | None = None
    ifsc: str | None = None


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
    summary = await priced(user.id, await load_cart(user.id))
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
    return {**dict(record), "events": rows(events), "return": await return_service.order_return(order_id)}


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
    await pool.execute("DELETE FROM coupon_redemptions WHERE order_id = $1", order_id)  # a cancelled order gives its coupon use back
    await return_stock(order_id)
    refund = await refund_order(order_id)  # paid online: back to the UPI app, bank or card it came from
    if refund:
        sent = "sent" if refund == "refunded" else "is being sent"
        amount = _inr(float(order["total"]))
        note = f"Refund of {amount} {sent} to your original payment method. Banks usually show it within 5–7 working days."
        await add_event(pool, order_id, "refunded" if refund == "refunded" else "refund_initiated", note)
    return {**dict(order), "refund": refund}


@router.post("/{order_id}/return", status_code=201)
async def request_return(order_id: int, body: ReturnIn, user: CurrentUser = Depends(get_current_user)):
    """Starts a return for a delivered order, within 7 days of delivery (see services/returns.py)."""
    return await return_service.request_return(user.id, order_id, body.model_dump())


@router.delete("/{order_id}/return")
async def withdraw_return(order_id: int, user: CurrentUser = Depends(get_current_user)):
    """Withdraws a return that is still waiting for a decision."""
    await return_service.withdraw(user.id, order_id)
    return {"ok": True}


# The admin's older one-step decision, kept for existing clients: approving books the pickup and takes the item back
# at once (stock back, refund out). The Seller Hub uses the step-by-step /api/seller/returns instead.
@router.get("/returns/pending")
async def pending_returns(admin: CurrentUser = Depends(require_admin)):
    return [r for r in await return_service.list_returns(admin.id, True) if r["status"] == "requested"]


@router.patch("/{order_id}/return")
async def resolve_return(order_id: int, body: ReturnDecisionIn, admin: CurrentUser = Depends(require_admin)):
    if not body.approve:
        return await return_service.act(admin.id, True, order_id, "reject", body.note or "Return not approved")
    await return_service.act(admin.id, True, order_id, "approve", body.note)
    return await return_service.act(admin.id, True, order_id, "receive")
