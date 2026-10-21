"""Predicts which products will sell the most over the next N days.

Supervised learning on the shop's own history: for many past "cutoff" dates we compute each
product's features as of that day (recent sales, momentum, views, add-to-carts, conversion,
price, discount, rating) and the target = units it actually sold in the following N days.
A gradient-boosted tree model learns that mapping and is then applied to today's features.

Validation uses the most recent cutoffs (never seen in training) and compares against the
naive "next month = last month" baseline.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

from .data import completed

FEATURES = [
    "units_7",
    "units_30",
    "units_90",
    "revenue_30",
    "views_30",
    "carts_30",
    "conversion_30",
    "momentum",
    "price",
    "discount_pct",
    "rating",
    "log_reviews",
    "days_listed",
]
FEATURE_LABELS = {
    "units_7": "Units sold (7 days)",
    "units_30": "Units sold (30 days)",
    "units_90": "Units sold (90 days)",
    "revenue_30": "Revenue (30 days)",
    "views_30": "Product views (30 days)",
    "carts_30": "Add-to-carts (30 days)",
    "conversion_30": "View → purchase rate",
    "momentum": "Sales momentum (7d vs 30d)",
    "price": "Price",
    "discount_pct": "Discount %",
    "rating": "Rating",
    "log_reviews": "Number of ratings",
    "days_listed": "Days listed",
}
CUTOFF_STEP_DAYS = 3
MIN_HISTORY_DAYS = 75


def _daily_matrix(frame: pd.DataFrame, date_col: str, value_col: str | None, days: pd.DatetimeIndex, products: list[str]) -> pd.DataFrame:
    """date x product matrix of daily totals (counts when value_col is None)."""
    if frame.empty:
        return pd.DataFrame(0.0, index=days, columns=products)
    grouped = frame.groupby([date_col, "product_id"])
    values = grouped[value_col].sum() if value_col else grouped.size()
    matrix = values.unstack(fill_value=0).reindex(index=days, columns=products, fill_value=0)
    return matrix.astype(float)


def _window(cumsum: pd.DataFrame, cutoff_pos: int, length: int) -> np.ndarray:
    """Sum over the `length` days before cutoff_pos, using a cumulative-sum matrix (O(1) per window)."""
    end = cumsum.iloc[cutoff_pos - 1].to_numpy() if cutoff_pos > 0 else 0
    start_pos = cutoff_pos - length - 1
    start = cumsum.iloc[start_pos].to_numpy() if start_pos >= 0 else 0
    return end - start


def _features_at(pos: int, cum: dict, static: pd.DataFrame, first_seen: np.ndarray) -> pd.DataFrame:
    u7, u30, u90 = (_window(cum["units"], pos, n) for n in (7, 30, 90))
    views, carts = _window(cum["views"], pos, 30), _window(cum["carts"], pos, 30)
    return pd.DataFrame(
        {
            "units_7": u7,
            "units_30": u30,
            "units_90": u90,
            "revenue_30": _window(cum["revenue"], pos, 30),
            "views_30": views,
            "carts_30": carts,
            "conversion_30": u30 / (views + 1),
            "momentum": (u7 / 7) / (u30 / 30 + 0.1),
            "price": static["price"].to_numpy(),
            "discount_pct": static["discount_pct"].to_numpy(),
            "rating": static["rating"].to_numpy(),
            "log_reviews": np.log1p(static["ratingCount"].to_numpy()),
            "days_listed": np.maximum(pos - first_seen, 0),
        },
        index=static.index,
    )


def predict_bestsellers(
    sales: pd.DataFrame, products: pd.DataFrame, events: pd.DataFrame, today: pd.Timestamp, horizon: int = 30, top: int = 20
) -> dict:
    done = completed(sales)
    products = products[products["active"]].copy()
    if done.empty or products.empty:
        return {"ready": False, "reason": "No sales yet."}

    start = done["date"].min()
    days = pd.date_range(start, today - pd.Timedelta(days=1), freq="D", tz=today.tz)
    if len(days) < MIN_HISTORY_DAYS:
        return {"ready": False, "reason": f"Needs at least {MIN_HISTORY_DAYS} days of sales history (have {len(days)})."}

    ids = products["product_id"].tolist()
    static = products.set_index("product_id").reindex(ids)
    static["discount_pct"] = ((static["mrp"] - static["price"]) / static["mrp"]).clip(lower=0).fillna(0) * 100
    static[["rating", "ratingCount"]] = static[["rating", "ratingCount"]].fillna(0)

    ev = events if not events.empty else pd.DataFrame(columns=["type", "productId", "date"])
    ev = ev.rename(columns={"productId": "product_id"})
    daily = {
        "units": _daily_matrix(done, "date", "qty", days, ids),
        "revenue": _daily_matrix(done, "date", "revenue", days, ids),
        "views": _daily_matrix(ev[ev["type"] == "view"], "date", None, days, ids),
        "carts": _daily_matrix(ev[ev["type"] == "add_to_cart"], "date", None, days, ids),
    }
    cum = {k: m.cumsum() for k, m in daily.items()}
    units_cum = cum["units"]
    sold = daily["units"].to_numpy() > 0
    first_seen = np.where(sold.any(axis=0), sold.argmax(axis=0), len(days))

    # Training samples: one row per (product, cutoff) with the units sold in the next `horizon` days as target
    cutoffs = list(range(30, len(days) - horizon + 1, CUTOFF_STEP_DAYS))
    samples, targets, cutoff_of = [], [], []
    for pos in cutoffs:
        samples.append(_features_at(pos, cum, static, first_seen))
        future = units_cum.iloc[pos + horizon - 1].to_numpy() - units_cum.iloc[pos - 1].to_numpy()
        targets.append(future)
        cutoff_of.append(np.full(len(ids), pos))
    X = pd.concat(samples, ignore_index=True)[FEATURES]
    y = np.concatenate(targets)
    cut = np.concatenate(cutoff_of)

    # Validate on the most recent cutoffs (time-based split: never train on the future)
    split = cutoffs[int(len(cutoffs) * 0.8)]
    train, test = cut < split, cut >= split

    def new_model():
        return GradientBoostingRegressor(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=42)

    model = new_model().fit(X[train], np.log1p(y[train]))
    pred_test = np.expm1(model.predict(X[test])).clip(min=0)
    baseline = (X.loc[test, "units_30"] * horizon / 30).to_numpy()

    last = cut == cutoffs[-1]  # top-10 hit rate on the latest validation cutoff
    actual_top = set(np.argsort(-y[last])[:10])
    predicted_top = set(np.argsort(-np.expm1(model.predict(X[last])))[:10])

    metrics = {
        "trainingSamples": int(train.sum()),
        "validationSamples": int(test.sum()),
        "mae": round(float(mean_absolute_error(y[test], pred_test)), 2),
        "baselineMae": round(float(mean_absolute_error(y[test], baseline)), 2),
        "r2": round(float(r2_score(y[test], pred_test)), 3),
        "top10HitRate": round(len(actual_top & predicted_top) / 10, 2),
    }
    metrics["improvementPct"] = round((1 - metrics["mae"] / metrics["baselineMae"]) * 100, 1) if metrics["baselineMae"] else None

    # Refit on everything and score today
    model = new_model().fit(X, np.log1p(y))
    now = _features_at(len(days), cum, static, first_seen)
    predicted = np.expm1(model.predict(now[FEATURES])).clip(min=0)

    result = static[["name", "category", "image", "price", "stock", "rating"]].copy()
    result["predictedUnits"] = predicted.round(1)
    result["last30Units"] = now["units_30"].to_numpy()
    result["growthPct"] = np.where(
        result["last30Units"] > 0, (result["predictedUnits"] * 30 / horizon / result["last30Units"] - 1) * 100, np.nan
    )
    daily_rate = result["predictedUnits"] / horizon
    result["daysOfStock"] = np.where(daily_rate > 0.01, result["stock"] / daily_rate, np.inf)
    result["restock"] = result["daysOfStock"] < 21
    result = result.sort_values("predictedUnits", ascending=False)

    def records(frame: pd.DataFrame) -> list[dict]:
        out = []
        for pid, r in frame.iterrows():
            out.append(
                {
                    "productId": pid,
                    "name": r["name"],
                    "category": r["category"],
                    "image": r["image"],
                    "price": float(r["price"]),
                    "stock": int(r["stock"]),
                    "rating": float(r["rating"]),
                    "predictedUnits": float(r["predictedUnits"]),
                    "last30Units": int(r["last30Units"]),
                    "growthPct": None if pd.isna(r["growthPct"]) else round(float(r["growthPct"]), 1),
                    "daysOfStock": None if np.isinf(r["daysOfStock"]) else round(float(r["daysOfStock"]), 1),
                    "restock": bool(r["restock"]),
                }
            )
        return out

    importances = sorted(zip(FEATURES, model.feature_importances_, strict=False), key=lambda x: -x[1])
    scatter = [
        {
            "name": static.at[pid, "name"],
            "category": static.at[pid, "category"],
            "price": float(static.at[pid, "price"]),
            "units": int(u),
            "rating": float(static.at[pid, "rating"]),
        }
        for pid, u in zip(ids, now["units_30"], strict=False)
    ]
    return {
        "ready": True,
        "model": "Gradient-boosted trees on product sales, traffic and price features",
        "horizonDays": horizon,
        "top": records(result.head(top)),
        "rising": records(
            result[(result["last30Units"] >= 3) & (result["growthPct"] > 15)].sort_values("growthPct", ascending=False).head(8)
        ),
        "restock": records(result[result["restock"] & (result["predictedUnits"] >= 1)].sort_values("daysOfStock").head(10)),
        "featureImportance": [{"feature": FEATURE_LABELS[f], "importance": round(float(v), 4)} for f, v in importances],
        "priceVsUnits": scatter,
        "metrics": metrics,
    }
