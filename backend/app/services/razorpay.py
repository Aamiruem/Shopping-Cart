"""Razorpay (an RBI-authorised payment aggregator): UPI, net banking with every RBI-licensed bank, cards and wallets.

Thin client over the REST API (https://razorpay.com/docs/api/) so no extra SDK is needed.
Flow: create a Razorpay order -> the shopper pays in Razorpay Checkout -> we verify the signature
server-side -> only then is the store order created. Webhooks keep payment status in sync.
"""

import hashlib
import hmac

import httpx

from ..core.config import get_settings
from ..core.errors import ApiError

API = "https://api.razorpay.com/v1"


def is_configured() -> bool:
    s = get_settings()
    return bool(s.razorpay_key_id and s.razorpay_key_secret)


def _auth() -> tuple[str, str]:
    if not is_configured():
        raise ApiError(503, "Online payments are not set up yet. Please choose cash on delivery.")
    s = get_settings()
    return s.razorpay_key_id, s.razorpay_key_secret


async def _call(method: str, path: str, json: dict | None = None) -> dict:
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.request(method, f"{API}{path}", auth=_auth(), json=json)
    except httpx.HTTPError:
        raise ApiError(502, "The payment service is not responding. Please try again.") from None
    if res.status_code >= 400:
        is_json = res.headers.get("content-type", "").startswith("application/json")
        detail = res.json().get("error", {}).get("description") if is_json else None
        raise ApiError(502, f"Payment service error: {detail or res.status_code}")
    return res.json()


async def create_order(amount_rupees: float, receipt: str, notes: dict | None = None) -> dict:
    """Creates a Razorpay order; Razorpay works in paise (1 rupee = 100 paise)."""
    body = {"amount": round(amount_rupees * 100), "currency": "INR", "receipt": receipt, "notes": notes or {}}
    return await _call("POST", "/orders", body)


async def fetch_payment(payment_id: str) -> dict:
    return await _call("GET", f"/payments/{payment_id}")


async def refund(payment_id: str, amount_rupees: float | None = None) -> dict:
    """Full refund by default; the money goes back to the original UPI app / bank / card."""
    body = {"amount": round(amount_rupees * 100)} if amount_rupees is not None else {}
    return await _call("POST", f"/payments/{payment_id}/refund", body)


def _hmac(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def verify_payment_signature(order_id: str, payment_id: str, signature: str) -> bool:
    """Checkout returns razorpay_signature = HMAC-SHA256(order_id|payment_id, key_secret)."""
    secret = get_settings().razorpay_key_secret
    return bool(secret and signature) and hmac.compare_digest(_hmac(secret, f"{order_id}|{payment_id}".encode()), signature)


def verify_webhook_signature(body: bytes, signature: str) -> bool:
    """Webhooks carry X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret)."""
    secret = get_settings().razorpay_webhook_secret
    return bool(secret and signature) and hmac.compare_digest(_hmac(secret, body), signature)
