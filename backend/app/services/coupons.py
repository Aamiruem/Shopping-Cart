"""Coupon codes (same tables and rules as api/_shop.mjs): one use per customer, given back if the order is cancelled.

Owners create them with `npm run coupon` (repository root) or straight in the `coupons` table.
"""

import math
import re
from datetime import UTC, datetime

from ..core.errors import ApiError
from ..db.postgres import get_pool
from .cart import summarize

COUPON_RE = re.compile(r"^[A-Z0-9_-]{3,30}$")


def _rupees(n: float) -> str:
    return f"₹{round(n):,}"


def coupon_problem(c, subtotal: float, used: bool, now: datetime | None = None) -> str | None:
    """Why a coupon can't be used on this cart right now, or None if it can."""
    now = now or datetime.now(UTC)
    if not c["active"]:
        return "This coupon is no longer available"
    if c["starts_at"] > now:
        return "This coupon isn’t active yet"
    if c["ends_at"] and c["ends_at"] <= now:
        return "This coupon has expired"
    if used:
        return "You’ve already used this coupon"
    minimum = float(c["min_order"])
    if subtotal < minimum:
        return f"Add items worth {_rupees(minimum - subtotal)} more to use {c['code']}"
    return None


def coupon_savings(c, subtotal: float) -> int:
    """Whole rupees off: a percentage up to its cap, or a flat amount up to the order value."""
    value = float(c["value"])
    off = math.floor(subtotal * value / 100) if c["kind"] == "percent" else math.floor(value)
    cap = math.inf if c["max_discount"] is None else float(c["max_discount"])
    return int(max(0, min(off, cap, subtotal)))


async def applied_coupon(user_id: int):
    return await get_pool().fetchrow(
        """SELECT c.*, EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.code = c.code AND r.user_id = $1) AS used
             FROM cart_coupons cc JOIN coupons c ON c.code = cc.code WHERE cc.user_id = $1""",
        user_id,
    )


async def priced(user_id: int, lines: list[dict]) -> dict:
    """The cart's price breakdown with the shopper's coupon, if one applies."""
    summary = summarize(lines)
    coupon = await applied_coupon(user_id)
    error = coupon_problem(coupon, summary["subtotal"], coupon["used"]) if coupon else None
    discount = coupon_savings(coupon, summary["subtotal"]) if coupon and not error else 0
    return {
        **summary,
        "coupon": {"code": coupon["code"], "description": coupon["description"], "savings": discount} if coupon else None,
        "couponError": error,
        "couponDiscount": discount,
        "total": summary["total"] - discount,
    }


async def apply(user_id: int, code: str, lines: list[dict]) -> None:
    code = (code or "").strip().upper()
    if not COUPON_RE.match(code):
        raise ApiError(400, "Please enter a valid coupon code")
    coupon = await get_pool().fetchrow(
        """SELECT c.*, EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.code = c.code AND r.user_id = $2) AS used
             FROM coupons c WHERE c.code = $1""",
        code,
        user_id,
    )
    if not coupon:
        raise ApiError(404, f"{code} isn’t a valid coupon code")
    if not lines:
        raise ApiError(400, "Add something to your cart first")
    if problem := coupon_problem(coupon, summarize(lines)["subtotal"], coupon["used"]):
        raise ApiError(400, problem)
    await get_pool().execute(
        """INSERT INTO cart_coupons (user_id, code) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, applied_at = NOW()""",
        user_id,
        code,
    )


async def remove(user_id: int) -> None:
    await get_pool().execute("DELETE FROM cart_coupons WHERE user_id = $1", user_id)


async def available(user_id: int) -> list[dict]:
    """Offers the shopper can use now, for the cart's "Available coupons" list."""
    records = await get_pool().fetch(
        """SELECT code, description, kind, value, min_order, max_discount, ends_at,
                  EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.code = c.code AND r.user_id = $1) AS used
             FROM coupons c
            WHERE active AND public AND starts_at <= NOW() AND (ends_at IS NULL OR ends_at > NOW())
            ORDER BY created_at DESC LIMIT 20""",
        user_id,
    )
    return [
        {
            **dict(r),
            "value": float(r["value"]),
            "min_order": float(r["min_order"]),
            "max_discount": None if r["max_discount"] is None else float(r["max_discount"]),
        }
        for r in records
    ]
