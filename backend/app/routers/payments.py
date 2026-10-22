"""/api/payments - online payments through Razorpay (UPI, net banking with every RBI-licensed bank, cards, wallets).

1. POST /razorpay/order   the cart total becomes a Razorpay order (nothing is charged yet)
2. Razorpay Checkout       the shopper pays in the browser with UPI / bank / card / wallet
3. POST /razorpay/verify  the signature is checked server-side, then the store order is created
4. POST /razorpay/webhook Razorpay tells us about captures, failures and refunds (keeps status right
                          even if the shopper closes the tab before step 3)
Every attempt is stored in the `payments` table for reconciliation and future reference.
"""

import json
import logging

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user
from ..services import razorpay
from ..services.orders import checkout_summary, place_order, resolve_address

router = APIRouter(prefix="/api/payments", tags=["payments"])
log = logging.getLogger("payments")
order_limiter = rate_limit(30, message="Too many payment attempts. Please try again in a few minutes.")

# Razorpay payment.method -> our orders.payment_method
METHODS = {"upi": "upi", "card": "card", "netbanking": "netbanking", "wallet": "wallet", "emi": "emi"}


class StartIn(BaseModel):
    addressId: int | None = None
    address: str | None = None


class VerifyIn(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


@router.get("/config")
async def config():
    """What the checkout page can offer."""
    enabled = razorpay.is_configured()
    return {
        "provider": "razorpay" if enabled else None,
        "enabled": enabled,
        "keyId": get_settings().razorpay_key_id if enabled else None,
        "methods": ["upi", "netbanking", "card", "wallet"] if enabled else [],
    }


@router.post("/razorpay/order", dependencies=[Depends(order_limiter)])
async def start_payment(body: StartIn, user: CurrentUser = Depends(get_current_user)):
    address = await resolve_address(user.id, body.addressId, body.address)
    _, summary = await checkout_summary(user.id)
    pool = get_pool()
    account = await pool.fetchrow("SELECT name, email, phone FROM users WHERE id = $1", user.id)
    rp_order = await razorpay.create_order(summary["total"], receipt=f"user{user.id}", notes={"userId": str(user.id)})
    await pool.execute(
        "INSERT INTO payments (user_id, provider_order_id, amount, address) VALUES ($1, $2, $3, $4)",
        user.id,
        rp_order["id"],
        summary["total"],
        address,
    )
    return {
        "keyId": get_settings().razorpay_key_id,
        "orderId": rp_order["id"],
        "amount": rp_order["amount"],  # paise
        "currency": rp_order["currency"],
        "name": "Arvixa",
        "description": f"{len(summary['items'])} item(s)",
        "prefill": {"name": account["name"], "email": account["email"], "contact": account["phone"] or ""},
    }


@router.post("/razorpay/verify")
async def verify_payment(body: VerifyIn, user: CurrentUser = Depends(get_current_user)):
    pool = get_pool()
    payment = await pool.fetchrow("SELECT * FROM payments WHERE provider_order_id = $1 AND user_id = $2", body.razorpay_order_id, user.id)
    if not payment:
        raise ApiError(404, "Payment not found")
    if payment["status"] == "paid" and payment["order_id"]:  # double submit / page refresh
        return {"orderId": payment["order_id"], "status": "paid"}
    if not razorpay.verify_payment_signature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature):
        await pool.execute(
            "UPDATE payments SET status = 'failed', error = 'signature mismatch', updated_at = NOW() WHERE id = $1", payment["id"]
        )
        raise ApiError(400, "We could not verify this payment. If money was deducted it will be refunded automatically.")

    details = await razorpay.fetch_payment(body.razorpay_payment_id)
    method = METHODS.get(details.get("method"), "upi")
    try:
        lines, summary = await checkout_summary(user.id)
        if round(summary["total"] * 100) != details.get("amount"):
            raise ApiError(409, "Your cart changed during payment. The amount has been refunded; please check out again.")
        order = await place_order(user.id, payment["address"], method, lines, summary)
    except ApiError as err:
        # Paid but we can't fulfil (cart changed, stock ran out): give the money back straight away
        await razorpay.refund(body.razorpay_payment_id)
        await pool.execute(
            "UPDATE payments SET status = 'refunded', provider_payment_id = $1, method = $2, error = $3, updated_at = NOW() WHERE id = $4",
            body.razorpay_payment_id,
            method,
            err.message,
            payment["id"],
        )
        raise
    await pool.execute(
        "UPDATE payments SET status = 'paid', order_id = $1, provider_payment_id = $2, method = $3, updated_at = NOW() WHERE id = $4",
        order["id"],
        body.razorpay_payment_id,
        method,
        payment["id"],
    )
    return {"orderId": order["id"], "status": "paid", "method": method}


@router.post("/razorpay/webhook", include_in_schema=False)
async def webhook(request: Request):
    """Configure in Razorpay Dashboard -> Webhooks with events payment.captured, payment.failed, refund.processed."""
    raw = await request.body()
    if not razorpay.verify_webhook_signature(raw, request.headers.get("x-razorpay-signature", "")):
        raise ApiError(400, "Invalid signature")
    event = json.loads(raw)
    kind = event.get("event", "")
    entity = (event.get("payload", {}).get("payment") or {}).get("entity") or {}
    pool = get_pool()
    if kind == "payment.failed" and entity.get("order_id"):
        await pool.execute(
            "UPDATE payments SET status = 'failed', error = $1, updated_at = NOW() WHERE provider_order_id = $2 AND status = 'created'",
            (entity.get("error_description") or "payment failed")[:500],
            entity["order_id"],
        )
    elif kind == "payment.captured" and entity.get("order_id"):
        # Normally /verify already did this; if the shopper closed the tab, the row stays 'created' and is
        # flagged here so support can reconcile (refund or place the order) from the admin side.
        await pool.execute(
            """UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, $1),
                      error = CASE WHEN status = 'created' THEN 'captured without order - needs review' ELSE error END,
                      updated_at = NOW()
                WHERE provider_order_id = $2""",
            entity.get("id"),
            entity["order_id"],
        )
    elif kind == "refund.processed":
        refund = (event.get("payload", {}).get("refund") or {}).get("entity") or {}
        await pool.execute(
            "UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE provider_payment_id = $1", refund.get("payment_id")
        )
    log.info("razorpay webhook %s", kind)
    return {"ok": True}


@router.get("/mine")
async def my_payments(user: CurrentUser = Depends(get_current_user)):
    """The shopper's payment history (successful, failed and refunded)."""
    return rows(
        await get_pool().fetch(
            """SELECT id, order_id, provider, provider_payment_id, method, amount, status, created_at
                 FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100""",
            user.id,
        )
    )
