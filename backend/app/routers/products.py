"""/api/products - public catalog (search, filters, facets) plus admin/seller write endpoints."""

import re

from fastapi import APIRouter, Depends, Response

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser, get_optional_user, require_seller
from ..schemas.product import ProductIn
from ..services import events
from ..services import products as product_service
from ..services.catalog import serialize_product, to_object_id

router = APIRouter(prefix="/api/products", tags=["products"])

SORTS = {
    "relevance": [("featured", -1), ("rating", -1)],
    "popularity": [("ratingCount", -1)],
    "price_asc": [("price", 1)],
    "price_desc": [("price", -1)],
    "rating": [("rating", -1)],
    "newest": [("createdAt", -1)],
}


def _base_filter(q: str | None, category: str | None) -> dict:
    """Shared by list and facets so both see the same search + category scope."""
    query: dict = {"active": {"$ne": False}}
    if q and q.strip():
        pattern = re.compile(re.escape(q.strip()), re.I)
        query["$or"] = [{"name": pattern}, {"brand": pattern}, {"category": pattern}, {"subCategory": pattern}, {"tags": pattern}]
    if category:
        query["category"] = category
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
    brand: str | None = None,
    minPrice: str | None = None,
    maxPrice: str | None = None,
    minRating: str | None = None,
    sort: str = "relevance",
    featured: str | None = None,
    limit: int = 200,
):
    """Returns a plain array - the AI service depends on this shape."""
    query = _base_filter(q, category)
    if brand:
        query["brand"] = {"$in": brand.split(",")}
    low, high = _number(minPrice), _number(maxPrice)
    if low is not None or high is not None:
        query["price"] = {**({"$gte": low} if low is not None else {}), **({"$lte": high} if high is not None else {})}
    if (rating := _number(minRating)) is not None:
        query["rating"] = {"$gte": rating}
    if featured == "true":
        query["featured"] = True

    cursor = get_db().products.find(query).sort(SORTS.get(sort, SORTS["relevance"])).limit(max(1, min(limit, 200)))
    return [serialize_product(p) async for p in cursor]


@router.get("/categories")
async def categories():
    """Category list with product counts and a cover image (the best-rated product)."""
    pipeline = [
        {"$match": {"active": {"$ne": False}}},
        {"$sort": {"rating": -1}},
        {"$group": {"_id": "$category", "count": {"$sum": 1}, "image": {"$first": "$image"}}},
        {"$sort": {"_id": 1}},
    ]
    return [{"id": r["_id"], "count": r["count"], "image": r["image"]} async for r in await get_db().products.aggregate(pipeline)]


@router.get("/facets")
async def facets(q: str | None = None, category: str | None = None):
    """Brands and price range for the filter sidebar."""
    db = get_db()
    query = _base_filter(q, category)
    brands = await db.products.distinct("brand", query)
    ranges = [
        r
        async for r in await db.products.aggregate(
            [{"$match": query}, {"$group": {"_id": None, "min": {"$min": "$price"}, "max": {"$max": "$price"}}}]
        )
    ]
    price = ranges[0] if ranges else {"min": 0, "max": 0}
    return {"brands": sorted(b for b in brands if b), "minPrice": price["min"], "maxPrice": price["max"]}


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
