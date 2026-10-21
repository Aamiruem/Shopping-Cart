"""Descriptive analytics for the dashboard: KPIs, trends, mixes, heatmap, funnel and distributions."""

import numpy as np
import pandas as pd

from .data import completed

WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
PAYMENT_LABELS = {"upi": "UPI", "card": "Card", "cod": "Cash on delivery"}


def _kpis(lines: pd.DataFrame, first_order: pd.Series) -> dict:
    done = completed(lines)
    orders = lines.drop_duplicates("order_id")
    revenue = float(done["revenue"].sum())
    n_orders = int(done["order_id"].nunique())
    customers = done["user_id"].dropna().unique()
    start = lines["created_at"].min() if not lines.empty else None
    new = int(sum(1 for u in customers if start is not None and first_order.get(u) is not None and first_order[u] >= start))
    return {
        "revenue": round(revenue, 2),
        "orders": n_orders,
        "units": int(done["qty"].sum()),
        "avgOrderValue": round(revenue / n_orders, 2) if n_orders else 0,
        "customers": int(len(customers)),
        "newCustomers": new,
        "cancelRate": round(float((orders["status"] == "cancelled").mean() * 100), 1) if len(orders) else 0,
    }


def _change(now: float, before: float) -> float | None:
    return round((now / before - 1) * 100, 1) if before else None


def overview(sales: pd.DataFrame, events: pd.DataFrame, today: pd.Timestamp, days: int = 30) -> dict:
    start, prev_start = today - pd.Timedelta(days=days), today - pd.Timedelta(days=2 * days)
    period = sales[sales["created_at"] >= start]
    previous = sales[(sales["created_at"] >= prev_start) & (sales["created_at"] < start)]
    first_order = completed(sales).groupby("user_id")["created_at"].min()

    kpis, prev_kpis = _kpis(period, first_order), _kpis(previous, first_order)
    kpis["changes"] = {k: _change(kpis[k], prev_kpis[k]) for k in ("revenue", "orders", "avgOrderValue", "customers", "units")}

    done = completed(period)
    # Revenue trend with a 7-day moving average
    index = pd.date_range(start, today - pd.Timedelta(days=1), freq="D", tz=today.tz)
    daily = done.groupby("date").agg(revenue=("revenue", "sum"), orders=("order_id", "nunique")).reindex(index, fill_value=0)
    daily["avg7"] = daily["revenue"].rolling(7, min_periods=1).mean()
    trend = [
        {"date": d.strftime("%Y-%m-%d"), "revenue": round(float(r.revenue), 2), "orders": int(r.orders), "avg7": round(float(r.avg7), 2)}
        for d, r in daily.iterrows()
    ]

    by_category = done.groupby("category").agg(revenue=("revenue", "sum"), units=("qty", "sum"), orders=("order_id", "nunique"))
    categories = [
        {"category": c, "revenue": round(float(r.revenue), 2), "units": int(r.units), "orders": int(r.orders)}
        for c, r in by_category.sort_values("revenue", ascending=False).iterrows()
    ]

    # Orders by weekday x hour (local time)
    orders = done.drop_duplicates("order_id")
    grid = orders.groupby([orders["created_at"].dt.dayofweek, orders["created_at"].dt.hour]).size()
    heatmap = [
        {"day": WEEKDAYS[d], "dayIndex": int(d), "hour": int(h), "orders": int(grid.get((d, h), 0))} for d in range(7) for h in range(24)
    ]

    payments = period.drop_duplicates("order_id").groupby("payment_method").size()
    payment_mix = [{"method": PAYMENT_LABELS.get(m, m), "orders": int(n)} for m, n in payments.sort_values(ascending=False).items()]

    top = done.groupby(["product_id", "name"]).agg(revenue=("revenue", "sum"), units=("qty", "sum")).reset_index()
    top_products = [
        {"productId": r.product_id, "name": r.name, "revenue": round(float(r.revenue), 2), "units": int(r.units)}
        for r in top.sort_values("revenue", ascending=False).head(10).itertuples()
    ]

    # Conversion funnel: distinct shoppers who viewed -> added to cart -> purchased in the period
    funnel = []
    if not events.empty:
        recent = events[(events["ts"] >= start) & events["userId"].notna()]
        for stage, kind in (("Viewed a product", "view"), ("Added to cart", "add_to_cart"), ("Purchased", "purchase")):
            funnel.append({"stage": stage, "users": int(recent.loc[recent["type"] == kind, "userId"].nunique())})

    # New vs returning customers per week
    weekly = []
    if not done.empty:
        is_first = orders["created_at"] <= orders["user_id"].map(first_order)
        tagged = orders.assign(kind=np.where(is_first, "new", "returning"))
        tagged["week"] = tagged["created_at"].dt.tz_localize(None).dt.to_period("W").dt.start_time
        pivot = tagged.groupby(["week", "kind"]).size().unstack(fill_value=0)
        weekly = [
            {"week": w.strftime("%d %b"), "new": int(r.get("new", 0)), "returning": int(r.get("returning", 0))} for w, r in pivot.iterrows()
        ]

    # Order value distribution
    order_values = done.groupby("order_id")["revenue"].sum()
    distribution = []
    if len(order_values):
        edges = [0, 500, 1000, 2500, 5000, 10000, 25000, 50000, np.inf]
        labels = ["<₹500", "₹500–1k", "₹1k–2.5k", "₹2.5k–5k", "₹5k–10k", "₹10k–25k", "₹25k–50k", "₹50k+"]
        counts = pd.cut(order_values, bins=edges, labels=labels, right=False).value_counts().reindex(labels, fill_value=0)
        distribution = [{"range": label, "orders": int(n)} for label, n in counts.items()]

    cities = (
        orders.groupby(orders["city"].fillna("Other")).size().sort_values(ascending=False).head(8)
        if "city" in orders
        else pd.Series(dtype=int)
    )
    city_mix = [{"city": c, "orders": int(n)} for c, n in cities.items()]

    return {
        "days": days,
        "kpis": kpis,
        "trend": trend,
        "categories": categories,
        "heatmap": heatmap,
        "paymentMix": payment_mix,
        "topProducts": top_products,
        "funnel": funnel,
        "newVsReturning": weekly,
        "orderValueDistribution": distribution,
        "cities": city_mix,
    }
