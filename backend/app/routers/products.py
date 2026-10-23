"""/api/products - public catalog (search, filters, facets) plus admin/seller write endpoints."""

import re

from fastapi import APIRouter, Depends, Response

from ..core.cache import cached, invalidate
from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser, get_optional_user, require_seller
from ..schemas.product import ProductIn
from ..services import events
from ..services import products as product_service
from ..services.catalog import CATEGORY_GROUPS, serialize_product, to_object_id

router = APIRouter(prefix="/api/products", tags=["products"])

SORTS = {
    "relevance": [("featured", -1), ("rating", -1)],
    "popularity": [("ratingCount", -1)],
    "price_asc": [("price", 1)],
    "price_desc": [("price", -1)],
    "rating": [("rating", -1)],
    "newest": [("createdAt", -1)],
}


def _base_filter(q: str | None, category: str | None, audience: str | None = None, use: str | None = None) -> dict:
    """Shared by list and facets so both see the same search + category + audience + use scope."""
    query: dict = {"active": {"$ne": False}}
    if q and q.strip():
        pattern = re.compile(re.escape(q.strip()), re.I)
        query["$or"] = [{"name": pattern}, {"brand": pattern}, {"category": pattern}, {"subCategory": pattern}, {"tags": pattern}]
    if category:
        query["category"] = category
    elif use in CATEGORY_GROUPS:
        query["category"] = {"$in": CATEGORY_GROUPS[use]}
    if audience in ("women", "men"):
        query["audience"] = {"$in": [audience, "unisex"]}
    return query


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        raise ApiError(400, "Price and rating filters must be numbers") from None


@router.get("")
async def list_products(
    q: str | None = None,
    category: str | None = None,
    audience: str | None = None,
    use: str | None = None,
    subCategory: str | None = None,
    size: str | None = None,
    color: str | None = None,
    ageGroup: str | None = None,
    brand: str | None = None,
    minPrice: str | None = None,
    maxPrice: str | None = None,
    minRating: str | None = None,
    sort: str = "relevance",
    featured: str | None = None,
    limit: int = 200,
):
    """Returns a plain array - the AI service depends on this shape."""
    query = _base_filter(q, category, audience, use)
    if subCategory:
        query["subCategory"] = subCategory
    for field, value in (("sizes", size), ("colors", color), ("ageGroups", ageGroup)):
        if value:
            query[field] = {"$in": value.split(",")}
    if brand:
        query["brand"] = {"$in": brand.split(",")}
    low, high = _number(minPrice), _number(maxPrice)
    if low is not None or high is not None:
        query["price"] = {**({"$gte": low} if low is not None else {}), **({"$lte": high} if high is not None else {})}
    if (rating := _number(minRating)) is not None:
        query["rating"] = {"$gte": rating}
    if featured == "true":
        query["featured"] = True

    limit = max(1, min(limit, 200))
    parts = (q, category, audience, use, subCategory, size, color, ageGroup, brand, minPrice, maxPrice, minRating, sort, featured, limit)
    key = "catalog:list:" + "|".join(str(x) for x in parts)
    return await cached(key, CATALOG_TTL, lambda: _search(query, q, sort, limit))


CATALOG_TTL = 30  # seconds; any product write clears it (see invalidate_catalog)


def invalidate_catalog() -> None:
    invalidate("catalog:")


async def _search(query: dict, q: str | None, sort: str, limit: int) -> list[dict]:
    """Relevance search: full-text matches ranked by score first, then partial-word matches (e.g. "lay" -> Lay's)."""
    db = get_db()
    if q and q.strip() and sort == "relevance":
        text_query = {k: v for k, v in query.items() if k != "$or"} | {"$text": {"$search": q.strip()}}
        ranked = [
            p
            async for p in db.products.find(text_query, {"score": {"$meta": "textScore"}})
            .sort([("score", {"$meta": "textScore"}), ("ratingCount", -1)])
            .limit(limit)
        ]
        seen = {p["_id"] for p in ranked}
        if len(ranked) < limit:
            async for p in db.products.find(query).sort(SORTS["popularity"]).limit(limit):
                if p["_id"] not in seen and len(ranked) < limit:
                    ranked.append(p)
        return [serialize_product({k: v for k, v in p.items() if k != "score"}) for p in ranked]
    cursor = db.products.find(query).sort(SORTS.get(sort, SORTS["relevance"])).limit(limit)
    return [serialize_product(p) async for p in cursor]


@router.get("/categories")
async def categories():
    """Category list with product counts and a cover image (the best-rated product)."""
    return await cached("catalog:categories", CATALOG_TTL, _categories)


async def _categories():
    pipeline = [
        {"$match": {"active": {"$ne": False}}},
        {"$sort": {"rating": -1}},
        {"$group": {"_id": "$category", "count": {"$sum": 1}, "image": {"$first": "$image"}}},
        {"$sort": {"_id": 1}},
    ]
    return [{"id": r["_id"], "count": r["count"], "image": r["image"]} async for r in await get_db().products.aggregate(pipeline)]


@router.get("/subcategories")
async def subcategories(category: str):
    """Sub-categories (e.g. grocery aisles) of one category, with product counts and a cover image."""
    return await cached(f"catalog:subcategories:{category}", CATALOG_TTL, lambda: _subcategories(category))


async def _subcategories(category: str):
    pipeline = [
        {"$match": {"active": {"$ne": False}, "category": category}},
        {"$sort": {"ratingCount": -1}},
        {"$group": {"_id": "$subCategory", "count": {"$sum": 1}, "image": {"$first": "$image"}}},
        {"$sort": {"_id": 1}},
    ]
    rows = await get_db().products.aggregate(pipeline)
    return [{"id": r["_id"], "count": r["count"], "image": r["image"]} async for r in rows if r["_id"]]


@router.get("/facets")
async def facets(q: str | None = None, category: str | None = None, audience: str | None = None, use: str | None = None):
    """Brands and price range for the filter sidebar."""
    key = f"catalog:facets:{q}|{category}|{audience}|{use}"
    return await cached(key, CATALOG_TTL, lambda: _facets(q, category, audience, use))


async def _facets(q, category, audience, use):
    db = get_db()
    query = _base_filter(q, category, audience, use)
    brands = await db.products.distinct("brand", query)
    ranges = [
        r
        async for r in await db.products.aggregate(
            [{"$match": query}, {"$group": {"_id": None, "min": {"$min": "$price"}, "max": {"$max": "$price"}}}]
        )
    ]
    price = ranges[0] if ranges else {"min": 0, "max": 0}
    sizes = [s for s in await db.products.distinct("sizes", query) if s]
    colors = [c for c in await db.products.distinct("colors", query) if c]
    return {
        "brands": sorted(b for b in brands if b),
        "minPrice": price["min"],
        "maxPrice": price["max"],
        "sizes": sorted(sizes, key=_size_order),
        "colors": sorted(colors),
    }


SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "Free Size"]


def _size_order(size: str):
    """Letter sizes in wearing order, then numeric sizes (waist / shoe) by number."""
    if size in SIZE_ORDER:
        return (0, SIZE_ORDER.index(size), 0.0)
    try:
        return (1, 0, float(size))
    except ValueError:
        return (2, 0, 0.0)


@router.get("/{product_id}")
async def get_product(product_id: str, user: CurrentUser | None = Depends(get_optional_user)):
    oid = to_object_id(product_id)
    product = await get_db().products.find_one({"_id": oid, "active": {"$ne": False}}) if oid else None
    if not product:
        raise ApiError(404, "Product not found")
    await events.track("view", product, user.id if user else None)
    return serialize_product(product)


# Write endpoints: sellers manage their own products, admins manage all (see also /api/seller/products)
@router.post("", status_code=201)
async def create_product(body: ProductIn, actor: CurrentUser = Depends(require_seller)):
    return await product_service.create(body, actor)


@router.put("/{product_id}")
async def update_product(product_id: str, body: ProductIn, actor: CurrentUser = Depends(require_seller)):
    return await product_service.update(product_id, body, actor)


@router.delete("/{product_id}", status_code=204)
async def delete_product(product_id: str, actor: CurrentUser = Depends(require_seller)):
    await product_service.delete(product_id, actor)
    return Response(status_code=204)
