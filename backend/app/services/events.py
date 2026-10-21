"""Behaviour events (view / add_to_cart / purchase) in MongoDB.

They feed the conversion funnel, best-seller prediction and personalised recommendations.
Logging is best-effort: a failed write must never break the shopper's request.
"""

import logging
from datetime import UTC, datetime

from ..db.mongo import get_db

log = logging.getLogger("events")
EVENT_TYPES = ("view", "add_to_cart", "purchase")


async def track(event_type: str, product: dict, user_id: int | None, qty: int = 1) -> None:
    try:
        await get_db().events.insert_one(
            {
                "type": event_type,
                "userId": user_id,
                "productId": str(product["_id"]),
                "category": product.get("category"),
                "sellerId": product.get("sellerId"),
                "price": product.get("price"),
                "qty": qty,
                "ts": datetime.now(UTC),
            }
        )
    except Exception:  # noqa: BLE001 - analytics must not break shopping
        log.warning("could not record %s event", event_type, exc_info=True)


async def track_many(docs: list[dict]) -> None:
    if not docs:
        return
    try:
        await get_db().events.insert_many(docs, ordered=False)
    except Exception:  # noqa: BLE001
        log.warning("could not record %d events", len(docs), exc_info=True)
