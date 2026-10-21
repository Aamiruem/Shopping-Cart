"""/api/recommendations - personalised picks, frequently bought together and trending products."""

import asyncio

from fastapi import APIRouter, Depends

from ..db.mongo import get_db
from ..deps import CurrentUser, get_optional_user
from ..ml import cache, recommender
from ..ml.data import load_events, load_products, load_sales, local_today
from ..services.catalog import serialize_product, to_object_id

router = APIRouter(prefix="/api/recommendations", tags=["recommendations"])
TTL_SECONDS = 10 * 60


async def _model() -> recommender.RecommenderModel:
    async def compute():
        products = await load_products()
        events = await load_events(days=120)
        ids = products.loc[products["active"], "product_id"].tolist()
        return await asyncio.to_thread(recommender.build, events, ids)

    return await cache.cached("recommender", TTL_SECONDS, compute)


async def _trending_ids(k: int) -> list[str]:
    async def compute():
        events = await load_events(days=30)
        return await asyncio.to_thread(recommender.trending, events, local_today(), 24)

    return [t["productId"] for t in await cache.cached("trending", TTL_SECONDS, compute)][:k]


async def _hydrate(ids: list[str], extra: dict[str, dict] | None = None) -> list[dict]:
    """Product ids -> product JSON in the same order, skipping unlisted / out-of-stock products."""
    oids = [o for o in (to_object_id(i) for i in ids) if o]
    found = {str(p["_id"]): p async for p in get_db().products.find({"_id": {"$in": oids}, "active": {"$ne": False}, "stock": {"$gt": 0}})}
    return [{**serialize_product(found[i]), **(extra or {}).get(i, {})} for i in ids if i in found]


async def _popular(k: int, exclude: set[str] = frozenset(), category: str | None = None) -> list[dict]:
    query = {"active": {"$ne": False}, "stock": {"$gt": 0}, **({"category": category} if category else {})}
    cursor = get_db().products.find(query).sort([("ratingCount", -1)]).limit(k + len(exclude))
    return [serialize_product(p) async for p in cursor if str(p["_id"]) not in exclude][:k]


@router.get("/for-you")
async def for_you(k: int = 12, user: CurrentUser | None = Depends(get_optional_user)):
    """Collaborative filtering for known shoppers; trending / popular for guests and new shoppers."""
    k = max(1, min(k, 24))
    picks = recommender.for_user(await _model(), user.id if user else None, k)
    if picks:
        names = {}
        reasons = {p["becauseOf"] for p in picks}
        async for doc in get_db().products.find({"_id": {"$in": [to_object_id(r) for r in reasons]}}, {"name": 1}):
            names[str(doc["_id"])] = doc["name"]
        extra = {p["productId"]: {"reason": f"Because you looked at {names.get(p['becauseOf'], 'similar items')}"} for p in picks}
        items = await _hydrate([p["productId"] for p in picks], extra)
        return {"strategy": "personalised", "items": items}

    items = await _hydrate(await _trending_ids(k), {})
    if len(items) < k:
        items += await _popular(k - len(items), {i["_id"] for i in items})
    return {"strategy": "trending", "items": items}


@router.get("/trending")
async def trending(k: int = 12):
    items = await _hydrate(await _trending_ids(max(1, min(k, 24))))
    return items or await _popular(k)


@router.get("/together/{product_id}")
async def bought_together(product_id: str, k: int = 6):
    """Frequently bought together; falls back to 'shoppers also viewed' and then the same category."""
    k = max(1, min(k, 12))

    async def compute():
        sales = await load_sales()
        return await asyncio.to_thread(recommender.bought_together, sales, product_id, k)

    pairs = await cache.cached(f"together:{product_id}:{k}", TTL_SECONDS, compute)
    items = await _hydrate([p["productId"] for p in pairs], {p["productId"]: {"boughtTogether": p["orders"]} for p in pairs})
    strategy = "bought_together"
    if len(items) < k:
        similar = recommender.similar_items(await _model(), product_id, k)
        seen = {i["_id"] for i in items} | {product_id}
        items += await _hydrate([s for s in similar if s not in seen][: k - len(items)])
        strategy = strategy if pairs else "similar_shoppers"
    if len(items) < k:
        product = await get_db().products.find_one({"_id": to_object_id(product_id)}, {"category": 1}) if to_object_id(product_id) else None
        items += await _popular(k - len(items), {i["_id"] for i in items} | {product_id}, product and product.get("category"))
    return {"strategy": strategy, "items": items}
