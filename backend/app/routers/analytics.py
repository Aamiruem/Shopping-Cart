"""/api/analytics - dashboards and ML predictions.

Sellers see only their own products' data. Admins see the whole marketplace, or one seller with ?sellerId=.
Results are cached (settings.analytics_cache_minutes); POST /retrain clears the cache.
"""

import asyncio
import io

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..core.config import get_settings
from ..core.errors import ApiError
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, require_admin, require_seller
from ..ml import cache
from ..ml import support as support_ml
from ..ml.bestsellers import predict_bestsellers
from ..ml.customers import cohort_retention, predict_churn, segment_customers
from ..ml.data import completed, load_dataset, local_today
from ..ml.forecasting import forecast_revenue
from ..ml.overview import overview as build_overview

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _scope(user: CurrentUser, seller_id: int | None) -> int | None:
    """None = whole marketplace (admins only)."""
    if user.is_admin:
        return seller_id
    return user.id


def _ttl(minutes: float | None = None) -> float:
    return 60 * (minutes if minutes is not None else get_settings().analytics_cache_minutes)


@router.get("/sellers")
async def sellers(_: CurrentUser = Depends(require_admin)):
    """Stores for the admin's seller filter."""
    return rows(await get_pool().fetch('SELECT user_id AS id, store_name AS "storeName" FROM sellers ORDER BY store_name'))


@router.get("/overview")
async def overview(days: int = 30, sellerId: int | None = None, user: CurrentUser = Depends(require_seller)):
    if days not in (7, 30, 90, 180):
        raise ApiError(400, "days must be 7, 30, 90 or 180")
    scope = _scope(user, sellerId)

    async def compute():
        data = await load_dataset(scope)
        return await asyncio.to_thread(build_overview, data.sales, data.events, data.today, days)

    return await cache.cached(f"overview:{scope}:{days}", _ttl(2), compute)


@router.get("/forecast")
async def forecast(horizon: int = 30, sellerId: int | None = None, user: CurrentUser = Depends(require_seller)):
    horizon = max(7, min(horizon, 90))
    scope = _scope(user, sellerId)

    async def compute():
        data = await load_dataset(scope, with_events=False)
        return await asyncio.to_thread(forecast_revenue, data.sales, data.today, horizon)

    return await cache.cached(f"forecast:{scope}:{horizon}", _ttl(), compute)


@router.get("/bestsellers")
async def bestsellers(horizon: int = 30, sellerId: int | None = None, user: CurrentUser = Depends(require_seller)):
    horizon = max(7, min(horizon, 60))
    scope = _scope(user, sellerId)

    async def compute():
        data = await load_dataset(scope)
        return await asyncio.to_thread(predict_bestsellers, data.sales, data.products, data.events, data.today, horizon)

    return await cache.cached(f"bestsellers:{scope}:{horizon}", _ttl(), compute)


@router.get("/customers")
async def customers(sellerId: int | None = None, user: CurrentUser = Depends(require_seller)):
    scope = _scope(user, sellerId)
    mask = not user.is_admin  # sellers don't get shoppers' full email addresses

    async def compute():
        data = await load_dataset(scope, with_users=True)

        def run():
            segments = segment_customers(data.sales, data.today)
            labels = segments.pop("labels", None)
            churn = predict_churn(data.sales, data.events, data.users, data.today, labels, mask_emails=mask)
            return {"segments": segments, "churn": churn, "cohorts": cohort_retention(data.sales)}

        return await asyncio.to_thread(run)

    return await cache.cached(f"customers:{scope}:{mask}", _ttl(), compute)


@router.get("/support")
async def support_stats(_: CurrentUser = Depends(require_admin)):
    pool = get_pool()
    by = {}
    for column in ("category", "priority", "status"):
        by[column] = rows(
            await pool.fetch(f"SELECT {column} AS key, COUNT(*)::int AS tickets FROM support_tickets GROUP BY 1 ORDER BY 2 DESC")
        )
    daily = rows(
        await pool.fetch(
            """SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS tickets,
                  ROUND(AVG(sentiment)::numeric, 3)::float8 AS sentiment
             FROM support_tickets WHERE created_at >= NOW() - INTERVAL '60 days' GROUP BY 1 ORDER BY 1"""
        )
    )
    sentiment = rows(
        await pool.fetch(
            """SELECT CASE WHEN sentiment <= -0.2 THEN 'Negative' WHEN sentiment >= 0.2 THEN 'Positive' ELSE 'Neutral' END AS key,
                  COUNT(*)::int AS tickets FROM support_tickets GROUP BY 1"""
        )
    )
    resolution = await pool.fetchval(
        """SELECT ROUND(AVG(EXTRACT(EPOCH FROM resolved_at - created_at) / 3600)::numeric, 1)::float8
             FROM support_tickets WHERE resolved_at IS NOT NULL"""
    )
    for item in by["category"]:
        item["label"] = support_ml.CATEGORY_LABELS.get(item["key"], item["key"])
    return {**by, "sentiment": sentiment, "daily": daily, "avgResolutionHours": resolution, "classifier": support_ml.classifier_info()}


@router.post("/retrain")
async def retrain(_: CurrentUser = Depends(require_admin)):
    """Drops cached models; the next dashboard request retrains on the latest data."""
    return {"clearedModels": cache.clear()}


@router.get("/export")
async def export(dataset: str = "orders", sellerId: int | None = None, user: CurrentUser = Depends(require_seller)):
    """CSV download for analysis in Excel / pandas / Power BI."""
    scope = _scope(user, sellerId)
    data = await load_dataset(scope, with_events=False)
    if dataset == "orders":
        frame = data.sales.drop(columns=["date"]).assign(created_at=lambda d: d["created_at"].dt.strftime("%Y-%m-%d %H:%M"))
    elif dataset == "products":
        done = completed(data.sales)
        sold = done.groupby("product_id").agg(units_sold=("qty", "sum"), revenue=("revenue", "sum"))
        frame = (
            data.products.drop(columns=["createdAt", "image"], errors="ignore")
            .set_index("product_id")
            .join(sold)
            .fillna({"units_sold": 0, "revenue": 0})
            .reset_index()
        )
    else:
        raise ApiError(400, "dataset must be 'orders' or 'products'")

    buffer = io.StringIO()
    frame.to_csv(buffer, index=False)
    filename = f"arvixa-{dataset}-{local_today():%Y%m%d}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )
