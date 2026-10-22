"""MongoDB (products, carts, wishlists, behaviour events) via PyMongo's async client.

Also works with Amazon DocumentDB (add tls=true&retryWrites=false to MONGO_URI).
"""

from pymongo import ASCENDING, DESCENDING, TEXT, AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

from ..core.config import get_settings

_client: AsyncMongoClient | None = None
_db: AsyncDatabase | None = None


async def connect_mongo() -> AsyncDatabase:
    global _client, _db
    _client = AsyncMongoClient(get_settings().mongo_uri, serverSelectionTimeoutMS=8000, tz_aware=True)
    _db = _client.get_default_database(default="shop")
    await _db.command("ping")
    await _ensure_indexes(_db)
    return _db


async def _ensure_indexes(db: AsyncDatabase) -> None:
    await db.products.create_index([("category", ASCENDING)])
    await db.products.create_index([("brand", ASCENDING)])
    await db.products.create_index([("sellerId", ASCENDING)])
    await db.products.create_index([("category", ASCENDING), ("subCategory", ASCENDING)])
    await db.products.create_index([("category", ASCENDING), ("audience", ASCENDING)])
    await db.products.create_index([("ratingCount", DESCENDING)])
    await db.products.create_index([("price", ASCENDING)])
    # Full-text search ranked by where the words appear (name first)
    await db.products.create_index(
        [("name", TEXT), ("brand", TEXT), ("tags", TEXT), ("subCategory", TEXT), ("category", TEXT)],
        weights={"name": 10, "brand": 6, "tags": 4, "subCategory": 2, "category": 1},
        name="product_search",
    )
    await db.carts.create_index([("userId", ASCENDING)], unique=True)
    await db.wishlists.create_index([("userId", ASCENDING)], unique=True)
    await db.events.create_index([("userId", ASCENDING), ("ts", DESCENDING)])
    await db.events.create_index([("productId", ASCENDING), ("type", ASCENDING)])
    await db.events.create_index([("ts", DESCENDING)])


async def close_mongo() -> None:
    global _client, _db
    if _client:
        await _client.close()
    _client = _db = None


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("MongoDB is not initialised")
    return _db
