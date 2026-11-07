"""Scheduled store automation: the routine jobs a small team would otherwise do by hand.

POST /api/automation/run calls these. Each job is independent and safe to repeat, so a scheduler can retry freely.
"""

import logging
from datetime import timedelta

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..db.postgres import get_pool
from . import mailer, razorpay

log = logging.getLogger("automation")

LOW_STOCK = 5
LATE_AFTER_DAYS = 2
STUCK_PAYMENT_MINUTES = 15


async def retry_refunds() -> dict:
    """Refunds that failed because the gateway was down. The shopper's money must not depend on someone noticing."""
    pool = get_pool()
    done = failed = 0
    for payment in await pool.fetch("SELECT id, provider_payment_id FROM payments WHERE status = 'refund_pending'"):
        try:
            await razorpay.refund(payment["provider_payment_id"])
        except ApiError:
            failed += 1
            continue
        await pool.execute("UPDATE payments SET status = 'refunded', error = NULL, updated_at = NOW() WHERE id = $1", payment["id"])
        done += 1
    return {"refunded": done, "stillPending": failed}


async def stuck_payments() -> dict:
    """Payments that started turning into an order and never finished (say, a crash). A person should look at these."""
    records = await get_pool().fetch(
        "SELECT id, provider_order_id FROM payments WHERE status = 'processing' AND updated_at < NOW() - $1::interval",
        timedelta(minutes=STUCK_PAYMENT_MINUTES),
    )
    for record in records:
        log.error("payment %s has been processing too long (%s)", record["id"], record["provider_order_id"])
    return {"needReview": len(records)}


async def _seller_emails(seller_ids: list[int]) -> dict[int, str]:
    records = await get_pool().fetch("SELECT id, email FROM users WHERE id = ANY($1::int[])", seller_ids)
    return {r["id"]: r["email"] for r in records}


async def low_stock_alerts() -> dict:
    """One email per seller listing the products about to sell out."""
    grouped: dict[int, list[str]] = {}
    query = {"active": {"$ne": False}, "stock": {"$gt": 0, "$lte": LOW_STOCK}, "sellerId": {"$ne": None}}
    async for product in get_db().products.find(query, {"name": 1, "stock": 1, "sellerId": 1}):
        grouped.setdefault(product["sellerId"], []).append(f"{product['name']}: {product['stock']} left")
    emails = await _seller_emails(list(grouped))
    for seller_id, lines in grouped.items():
        if seller_id in emails:
            await mailer.send_mail(to=emails[seller_id], subject="Products running low on Arvixa Store", text="\n".join(lines))
    return {"sellersAlerted": len(grouped)}


async def late_orders() -> dict:
    """Reminds sellers about paid orders that haven't been packed."""
    records = await get_pool().fetch(
        """SELECT DISTINCT oi.seller_id, oi.order_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.status = 'placed' AND oi.fulfilment = 'pending' AND o.created_at < NOW() - $1::interval
              AND oi.seller_id IS NOT NULL""",
        timedelta(days=LATE_AFTER_DAYS),
    )
    by_seller: dict[int, list[int]] = {}
    for record in records:
        by_seller.setdefault(record["seller_id"], []).append(record["order_id"])
    emails = await _seller_emails(list(by_seller))
    for seller_id, orders in by_seller.items():
        if seller_id in emails:
            listed = ", ".join(f"#{order}" for order in sorted(orders))
            await mailer.send_mail(to=emails[seller_id], subject="Orders waiting to be packed", text=f"Please pack these orders: {listed}")
    return {"lateOrders": len(records)}


async def run_all() -> dict:
    jobs = {"refunds": retry_refunds, "payments": stuck_payments, "lowStock": low_stock_alerts, "lateOrders": late_orders}
    results = {}
    for name, job in jobs.items():
        try:
            results[name] = await job()
        except Exception:  # one failing job must not stop the others
            log.exception("automation job %s failed", name)
            results[name] = {"error": True}
    return results
