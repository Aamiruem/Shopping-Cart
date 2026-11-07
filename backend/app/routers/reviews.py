"""/api/products/{id}/reviews - ratings and reviews, only from shoppers who received the product.

The product document keeps `reviewRating` and `reviewCount` so listings can show them without a SQL query. These
replace the catalog's sample `rating` and `ratingCount` wherever real shoppers are served.
"""

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from ..core.cache import invalidate
from ..core.errors import ApiError
from ..core.lazy import lazy_import
from ..core.rate_limit import rate_limit
from ..db.mongo import get_db
from ..db.postgres import get_pool
from ..deps import CurrentUser, get_current_user, get_optional_user
from ..services.catalog import to_object_id

support = lazy_import("app.ml.support")  # the sentiment model pulls in scikit-learn

router = APIRouter(prefix="/api/products", tags=["reviews"])
review_limiter = rate_limit(20, message="Too many reviews. Please try again later.")
PAGE_SIZE = 20


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=2000)


def _public_name(full_name: str) -> str:
    """First name and last initial: enough to feel real, without publishing a shopper's full name."""
    parts = full_name.split()
    return f"{parts[0]} {parts[-1][0]}." if len(parts) > 1 else (parts[0] if parts else "Shopper")


async def _has_received(user_id: int, product_id: str) -> bool:
    found = await get_pool().fetchval(
        """SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.user_id = $1 AND oi.product_id = $2 AND oi.fulfilment = 'delivered' AND o.status = 'placed' LIMIT 1""",
        user_id,
        product_id,
    )
    return found is not None


async def _summary(product_id: str) -> dict:
    grouped = await get_pool().fetch("SELECT rating, COUNT(*) AS n FROM product_reviews WHERE product_id = $1 GROUP BY rating", product_id)
    histogram = {stars: 0 for stars in range(1, 6)} | {r["rating"]: r["n"] for r in grouped}
    count = sum(histogram.values())
    average = round(sum(stars * n for stars, n in histogram.items()) / count, 1) if count else 0
    return {"average": average, "count": count, "histogram": histogram}


async def _refresh_product(product_id: str) -> None:
    summary = await _summary(product_id)
    await get_db().products.update_one(
        {"_id": to_object_id(product_id)}, {"$set": {"reviewRating": summary["average"], "reviewCount": summary["count"]}}
    )
    invalidate("catalog:")


@router.get("/{product_id}/reviews")
async def list_reviews(product_id: str, page: int = 1, user: CurrentUser | None = Depends(get_optional_user)):
    records = await get_pool().fetch(
        """SELECT r.id, r.rating, r.title, r.body, r.created_at, r.user_id, u.name
             FROM product_reviews r JOIN users u ON u.id = r.user_id
            WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3""",
        product_id,
        PAGE_SIZE,
        (max(page, 1) - 1) * PAGE_SIZE,
    )
    items = [
        {
            "id": r["id"],
            "rating": r["rating"],
            "title": r["title"],
            "body": r["body"],
            "author": _public_name(r["name"]),
            "createdAt": r["created_at"].isoformat(),
            "mine": bool(user and r["user_id"] == user.id),
        }
        for r in records
    ]
    return {**await _summary(product_id), "items": items, "canReview": bool(user and await _has_received(user.id, product_id))}


@router.post("/{product_id}/reviews", status_code=201, dependencies=[Depends(review_limiter)])
async def save_review(product_id: str, body: ReviewIn, user: CurrentUser = Depends(get_current_user)):
    """Creates the shopper's review, or replaces their earlier one."""
    if not to_object_id(product_id):
        raise ApiError(404, "Product not found")
    if not await _has_received(user.id, product_id):
        raise ApiError(403, "You can review a product once it has been delivered to you")
    title, text = body.title.strip(), body.body.strip()
    record = await get_pool().fetchrow(
        """INSERT INTO product_reviews (product_id, user_id, rating, title, body, sentiment) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (product_id, user_id) DO UPDATE
             SET rating = EXCLUDED.rating, title = EXCLUDED.title, body = EXCLUDED.body,
                 sentiment = EXCLUDED.sentiment, updated_at = NOW()
           RETURNING id, rating, title, body""",
        product_id,
        user.id,
        body.rating,
        title,
        text,
        support.sentiment(f"{title}. {text}") if title or text else None,
    )
    await _refresh_product(product_id)
    return dict(record)


@router.delete("/{product_id}/reviews/mine", status_code=204)
async def delete_review(product_id: str, user: CurrentUser = Depends(get_current_user)):
    await get_pool().execute("DELETE FROM product_reviews WHERE product_id = $1 AND user_id = $2", product_id, user.id)
    await _refresh_product(product_id)
    return Response(status_code=204)
