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
        "name": "Arvixa Store",
        "description": f"{len(summary['items'])} item(s)",
        "prefill": {"name": account["name"], "email": account["email"], "contact": account["phone"] or ""},
    }


def _method(details: dict) -> str:
    return METHODS.get(details.get("method"), "upi")


async def _claim(payment_row_id: int) -> bool:
    """Only one caller wins, so /verify, a double submit and the webhook can never create two orders for one payment."""
    claimed = await get_pool().fetchval(
        "UPDATE payments SET status = 'processing', updated_at = NOW() WHERE id = $1 AND status IN ('created', 'failed') RETURNING id",
        payment_row_id,
    )
    return claimed is not None


async def _result_of_claimed(payment_row_id: int) -> dict:
    row = await get_pool().fetchrow("SELECT status, order_id, error FROM payments WHERE id = $1", payment_row_id)
    if row["order_id"]:
        return {"orderId": row["order_id"], "status": "paid"}
    if row["status"] == "processing":
        raise ApiError(409, "We are confirming your payment. Please check My Orders in a minute.")
    raise ApiError(409, row["error"] or "This payment could not be completed.")


async def _refund_after_failure(payment_row_id: int, provider_payment_id: str, method: str, reason: str) -> None:
    """The money must go back. If Razorpay is down the row says so, for a retry from the dashboard."""
    pool = get_pool()
    try:
        await razorpay.refund(provider_payment_id)
        status = "refunded"
    except ApiError:
        log.exception("refund failed for payment %s", provider_payment_id)
        status = "refund_pending"
    await pool.execute(
        "UPDATE payments SET status = $1, provider_payment_id = $2, method = $3, error = $4, updated_at = NOW() WHERE id = $5",
        status,
        provider_payment_id,
        method,
        reason,
        payment_row_id,
    )


async def _settle(payment, provider_payment_id: str, details: dict) -> dict:
    """Turns a claimed payment into an order. If the order can't be placed, the shopper is refunded straight away."""
    pool = get_pool()
    method = _method(details)
    state = details.get("status")
    if state not in ("authorized", "captured"):
        await pool.execute("UPDATE payments SET status = 'created', updated_at = NOW() WHERE id = $1", payment["id"])
        raise ApiError(402, "This payment has not completed. No order was placed.")
    try:
        if state == "authorized":
            await razorpay.capture(provider_payment_id, details["amount"])
        lines, summary = await checkout_summary(payment["user_id"])
        if round(summary["total"] * 100) != details.get("amount"):
            raise ApiError(409, "Your cart changed during payment. The amount has been refunded; please check out again.")
        order = await place_order(payment["user_id"], payment["address"], method, lines, summary)
    except ApiError as err:
        await _refund_after_failure(payment["id"], provider_payment_id, method, err.message)
        raise
    await pool.execute(
        "UPDATE payments SET status = 'paid', order_id = $1, provider_payment_id = $2, method = $3, updated_at = NOW() WHERE id = $4",
        order["id"],
        provider_payment_id,
        method,
        payment["id"],
    )
    return order


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

    if not await _claim(payment["id"]):
        return await _result_of_claimed(payment["id"])
    details = await razorpay.fetch_payment(body.razorpay_payment_id)
    order = await _settle(payment, body.razorpay_payment_id, details)
    return {"orderId": order["id"], "status": "paid", "method": _method(details)}


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
        # Usually /verify got there first. If the shopper closed the tab after paying, this places the order.
        payment = await pool.fetchrow("SELECT * FROM payments WHERE provider_order_id = $1", entity["order_id"])
        if payment and await _claim(payment["id"]):
            try:
                await _settle(payment, entity["id"], entity)
            except ApiError:  # already refunded and recorded; Razorpay must not retry the webhook
                log.warning("captured payment %s could not become an order", entity["id"])
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
