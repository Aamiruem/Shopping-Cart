"""Loads marketplace data from PostgreSQL and MongoDB into pandas DataFrames for analytics and ML.

All timestamps are converted to the store's local timezone (settings.timezone) so "days" and
"hours" match what sellers see on the calendar.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pandas as pd

from ..core.config import get_settings
from ..db.mongo import get_db
from ..db.postgres import get_pool

SALES_COLUMNS = [
    "order_id",
    "product_id",
    "seller_id",
    "category",
    "name",
    "price",
    "qty",
    "user_id",
    "created_at",
    "status",
    "payment_method",
    "city",
    "revenue",
    "date",
]


@dataclass
class Dataset:
    sales: pd.DataFrame  # one row per order line
    products: pd.DataFrame  # catalog (scoped to the seller when relevant)
    events: pd.DataFrame  # view / add_to_cart / purchase
    users: pd.DataFrame  # customers who appear in sales
    today: pd.Timestamp  # local "today" (midnight)


def local_today() -> pd.Timestamp:
    return pd.Timestamp.now(tz=get_settings().timezone).normalize()


async def load_sales(seller_id: int | None = None) -> pd.DataFrame:
    records = await get_pool().fetch(
        """
        SELECT oi.order_id, oi.product_id, oi.seller_id, oi.category, oi.name, oi.price::float8 AS price, oi.qty,
               o.user_id, o.created_at, o.status, o.payment_method, u.city
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          LEFT JOIN users u ON u.id = o.user_id
         WHERE ($1::int IS NULL OR oi.seller_id = $1)
        """,
        seller_id,
    )
    df = pd.DataFrame([dict(r) for r in records], columns=SALES_COLUMNS[:-2])
    # Typed columns even when empty, so date maths works for a brand-new seller with no sales
    df = df.astype({"price": float, "qty": int, "order_id": int})
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True).dt.tz_convert(get_settings().timezone)
    df["revenue"] = df["price"] * df["qty"]
    df["date"] = df["created_at"].dt.normalize()
    df["category"] = df["category"].fillna("other")
    return df


async def load_products(seller_id: int | None = None) -> pd.DataFrame:
    query = {} if seller_id is None else {"sellerId": seller_id}
    projection = {
        "name": 1,
        "category": 1,
        "brand": 1,
        "price": 1,
        "mrp": 1,
        "rating": 1,
        "ratingCount": 1,
        "stock": 1,
        "image": 1,
        "sellerId": 1,
        "createdAt": 1,
        "active": 1,
    }
    docs = [d async for d in get_db().products.find(query, projection)]
    df = pd.DataFrame(docs)
    if df.empty:
        return pd.DataFrame(columns=["product_id", *projection])
    df["product_id"] = df.pop("_id").astype(str)
    for col, default in (("mrp", None), ("rating", 0.0), ("ratingCount", 0), ("stock", 0), ("active", True)):
        if col not in df:
            df[col] = default
    df["mrp"] = pd.to_numeric(df["mrp"], errors="coerce").fillna(df["price"])
    df["active"] = df["active"].fillna(True).astype(bool)
    return df


async def load_events(seller_id: int | None = None, days: int = 200) -> pd.DataFrame:
    since = datetime.now(UTC) - timedelta(days=days)
    query: dict = {"ts": {"$gte": since}}
    if seller_id is not None:
        query["sellerId"] = seller_id
    docs = [d async for d in get_db().events.find(query, {"_id": 0, "type": 1, "userId": 1, "productId": 1, "ts": 1, "qty": 1})]
    df = pd.DataFrame(docs, columns=["type", "userId", "productId", "ts", "qty"])
    if not df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.tz_convert(get_settings().timezone)
        df["date"] = df["ts"].dt.normalize()
    return df


async def load_users(user_ids: list[int]) -> pd.DataFrame:
    if not user_ids:
        return pd.DataFrame(columns=["user_id", "name", "email", "city", "created_at"])
    records = await get_pool().fetch("SELECT id AS user_id, name, email, city, created_at FROM users WHERE id = ANY($1::int[])", user_ids)
    return pd.DataFrame([dict(r) for r in records])


async def load_dataset(seller_id: int | None = None, with_events: bool = True, with_users: bool = False) -> Dataset:
    sales = await load_sales(seller_id)
    products = await load_products(seller_id)
    events = await load_events(seller_id) if with_events else pd.DataFrame(columns=["type", "userId", "productId", "ts", "qty", "date"])
    users = await load_users(sorted(int(u) for u in sales["user_id"].dropna().unique())) if with_users else pd.DataFrame()
    return Dataset(sales=sales, products=products, events=events, users=users, today=local_today())


def completed(sales: pd.DataFrame) -> pd.DataFrame:
    """Order lines that count as sales (cancelled orders excluded)."""
    return sales[sales["status"] != "cancelled"]
