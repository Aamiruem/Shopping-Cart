"""Data analysis and visualisation: EDA, statistical tests and the neural-network demand forecast."""

from fastapi import APIRouter, Depends, Query

from ...analytics import statistics
from ...core.security import User, require_seller, seller_scope
from ...db import queries
from ...db.postgres import analytics_session, query_df
from ...dl.demand_net import forecast_units

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/insights")
def insights(days: int = Query(90, ge=14, le=730), sellerId: int | None = None, user: User = Depends(require_seller)):  # noqa: N803
    """Dataset profile + statistical insights (confidence intervals, hypothesis tests, regression, correlation)."""
    params = {"days": days}
    with analytics_session(seller_scope(user, sellerId)) as conn:
        orders, _ = query_df(conn, queries.ORDERS, params)
        daily, _ = query_df(conn, queries.DAILY_SALES, params)
        products, _ = query_df(conn, queries.PRODUCT_SALES, params)
        category_city, _ = query_df(conn, queries.CATEGORY_CITY, params)
    if orders.empty:
        return {"days": days, "overview": None, "correlations": None, "insights": []}
    return {
        "days": days,
        "overview": statistics.overview(orders, daily),
        "correlations": statistics.correlations(products),
        "insights": statistics.insights(orders, daily, products, category_city),
    }


@router.get("/forecast")
def forecast(sellerId: int | None = None, user: User = Depends(require_seller)):  # noqa: N803
    """Neural-network forecast of units sold over the next 14 days, with a held-out backtest."""
    with analytics_session(seller_scope(user, sellerId)) as conn:
        daily, _ = query_df(conn, queries.DAILY_SALES, {"days": 180})
    return forecast_units(daily)
