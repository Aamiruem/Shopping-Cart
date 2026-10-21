"""Customer analytics: RFM segmentation (K-Means), churn prediction (random forest) and cohort retention."""

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, silhouette_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

from .data import completed

SEGMENT_NAMES = ["Champions", "Loyal", "Needs attention", "At risk"]  # best -> worst cluster
SEGMENT_ADVICE = {
    "Champions": "Reward them: early access, loyalty points, referral codes.",
    "Loyal": "Upsell premium products and bundles.",
    "Needs attention": "Send personalised recommendations and a limited-time offer.",
    "At risk": "Win back with a strong discount before they lapse for good.",
}
CHURN_WINDOW_DAYS = 45
CHURN_FEATURES = [
    "recency",
    "frequency",
    "monetary",
    "avg_order_value",
    "tenure",
    "avg_gap",
    "categories",
    "cancel_rate",
    "views_30",
    "carts_30",
]
CHURN_LABELS = {
    "recency": "Days since last order",
    "frequency": "Number of orders",
    "monetary": "Total spend",
    "avg_order_value": "Average order value",
    "tenure": "Days since first order",
    "avg_gap": "Average days between orders",
    "categories": "Categories bought",
    "cancel_rate": "Cancellation rate",
    "views_30": "Product views (30 days)",
    "carts_30": "Add-to-carts (30 days)",
}


# ---------- RFM segmentation ----------


def rfm_table(sales: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    done = completed(sales)
    done = done[done["created_at"] < as_of]
    orders = done.groupby(["user_id", "order_id"]).agg(when=("created_at", "max"), revenue=("revenue", "sum")).reset_index()
    rfm = orders.groupby("user_id").agg(
        last=("when", "max"), first=("when", "min"), frequency=("order_id", "nunique"), monetary=("revenue", "sum")
    )
    rfm["recency"] = (as_of - rfm["last"]).dt.days
    rfm["tenure"] = (as_of - rfm["first"]).dt.days
    return rfm


def segment_customers(sales: pd.DataFrame, today: pd.Timestamp) -> dict:
    rfm = rfm_table(sales, today)
    if len(rfm) < 12:
        return {"ready": False, "reason": f"Needs at least 12 customers (have {len(rfm)})."}

    X = np.column_stack([rfm["recency"], np.log1p(rfm["frequency"]), np.log1p(rfm["monetary"])])
    scaled = StandardScaler().fit_transform(X)
    k = 4
    km = KMeans(n_clusters=k, n_init=10, random_state=42).fit(scaled)

    # Rank clusters: recent, frequent, high-spend = best
    centers = km.cluster_centers_
    score = -centers[:, 0] + centers[:, 1] + centers[:, 2]
    names = {cluster: SEGMENT_NAMES[rank] for rank, cluster in enumerate(np.argsort(-score))}
    rfm["segment"] = [names[c] for c in km.labels_]

    summary = rfm.groupby("segment").agg(
        customers=("frequency", "size"),
        revenue=("monetary", "sum"),
        recency=("recency", "mean"),
        frequency=("frequency", "mean"),
        monetary=("monetary", "mean"),
    )
    segments = [
        {
            "segment": name,
            "customers": int(summary.at[name, "customers"]),
            "revenue": round(float(summary.at[name, "revenue"]), 2),
            "avgRecencyDays": round(float(summary.at[name, "recency"]), 1),
            "avgOrders": round(float(summary.at[name, "frequency"]), 2),
            "avgSpend": round(float(summary.at[name, "monetary"]), 2),
            "advice": SEGMENT_ADVICE[name],
        }
        for name in SEGMENT_NAMES
        if name in summary.index
    ]
    sample = rfm.sample(min(len(rfm), 600), random_state=1)
    points = [
        {"recency": int(r.recency), "frequency": int(r.frequency), "monetary": round(float(r.monetary), 2), "segment": r.segment}
        for r in sample.itertuples()
    ]
    return {
        "ready": True,
        "model": "K-Means (k=4) on Recency, Frequency, Monetary",
        "segments": segments,
        "points": points,
        "silhouette": round(float(silhouette_score(scaled, km.labels_)), 3),
        "labels": rfm["segment"],  # used by the churn table; stripped before sending
    }


# ---------- Cohort retention ----------


def cohort_retention(sales: pd.DataFrame, months: int = 6) -> list[dict]:
    done = completed(sales)
    if done.empty:
        return []
    month = done["created_at"].dt.tz_localize(None).dt.to_period("M")
    df = pd.DataFrame({"user_id": done["user_id"], "month": month})
    df["cohort"] = df.groupby("user_id")["month"].transform("min")
    df["offset"] = (df["month"] - df["cohort"]).apply(lambda d: d.n)
    counts = df.drop_duplicates(["user_id", "offset"]).groupby(["cohort", "offset"])["user_id"].nunique().unstack(fill_value=0)
    counts = counts.tail(months)
    out = []
    for cohort, row in counts.iterrows():
        size = int(row.get(0, 0))
        if not size:
            continue
        out.append(
            {
                "cohort": str(cohort),
                "size": size,
                "retention": [round(float(row.get(i, 0)) / size * 100, 1) if i in row.index else None for i in range(months)],
            }
        )
    return out


# ---------- Churn prediction ----------


def _churn_features(sales: pd.DataFrame, events: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    rfm = rfm_table(sales, as_of)
    if rfm.empty:
        return rfm
    before = sales[sales["created_at"] < as_of]
    rfm["avg_order_value"] = rfm["monetary"] / rfm["frequency"]
    rfm["avg_gap"] = np.where(rfm["frequency"] > 1, rfm["tenure"] / (rfm["frequency"] - 1).clip(lower=1), rfm["tenure"])
    rfm["categories"] = completed(before).groupby("user_id")["category"].nunique().reindex(rfm.index, fill_value=0)
    orders = before.drop_duplicates("order_id")
    rfm["cancel_rate"] = orders.assign(c=orders["status"] == "cancelled").groupby("user_id")["c"].mean().reindex(rfm.index, fill_value=0)
    recent = events[(events["ts"] < as_of) & (events["ts"] >= as_of - pd.Timedelta(days=30))] if not events.empty else events
    for kind, col in (("view", "views_30"), ("add_to_cart", "carts_30")):
        counts = recent[recent["type"] == kind].groupby("userId").size() if not recent.empty else pd.Series(dtype=float)
        rfm[col] = counts.reindex(rfm.index, fill_value=0).to_numpy()
    return rfm


def predict_churn(
    sales: pd.DataFrame,
    events: pd.DataFrame,
    users: pd.DataFrame,
    today: pd.Timestamp,
    segments: pd.Series | None = None,
    mask_emails: bool = False,
) -> dict:
    snapshot = today - pd.Timedelta(days=CHURN_WINDOW_DAYS)
    train = _churn_features(sales, events, snapshot)
    if len(train) < 30:
        return {"ready": False, "reason": f"Needs at least 30 customers with {CHURN_WINDOW_DAYS}+ days of history (have {len(train)})."}

    # Label: did the customer order again in the 45 days after the snapshot?
    returned = completed(sales)
    returned = set(returned[returned["created_at"] >= snapshot]["user_id"])
    y = (~train.index.isin(returned)).astype(int)
    if y.min() == y.max():
        return {"ready": False, "reason": "Needs both returning and lapsed customers to learn from."}

    X = train[CHURN_FEATURES].to_numpy(dtype=float)
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, stratify=y, random_state=42)

    def new_model():
        return RandomForestClassifier(
            n_estimators=300, max_depth=6, min_samples_leaf=3, class_weight="balanced", random_state=42, n_jobs=-1
        )

    model = new_model().fit(X_tr, y_tr)
    proba_te = model.predict_proba(X_te)[:, 1]
    auc = roc_auc_score(y_te, proba_te)
    predicted = proba_te >= 0.5
    precision = float((predicted & (y_te == 1)).sum() / max(predicted.sum(), 1))
    recall = float((predicted & (y_te == 1)).sum() / max((y_te == 1).sum(), 1))

    # Refit on all labelled customers, then score everyone using today's features
    model = new_model().fit(X, y)
    current = _churn_features(sales, events, today)
    current["churn"] = model.predict_proba(current[CHURN_FEATURES].to_numpy(dtype=float))[:, 1]

    hist, edges = np.histogram(current["churn"], bins=10, range=(0, 1))
    info = users.set_index("user_id") if not users.empty else pd.DataFrame()
    at_risk = (
        current[current["churn"] >= 0.5].assign(value=lambda d: d["churn"] * d["monetary"]).sort_values("value", ascending=False).head(15)
    )

    def who(uid: int) -> dict:
        if uid not in info.index:
            return {"name": f"Customer #{uid}", "email": None, "city": None}
        name, email, city = info.at[uid, "name"], info.at[uid, "email"], info.at[uid, "city"]
        if mask_emails and email:
            local, _, domain = email.partition("@")
            email = f"{local[0]}***@{domain}"
        return {"name": name, "email": email, "city": city}

    return {
        "ready": True,
        "model": f"Random forest · label = no order within {CHURN_WINDOW_DAYS} days",
        "metrics": {
            "auc": round(float(auc), 3),
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "trainingCustomers": int(len(train)),
            "historicalChurnRate": round(float(y.mean()) * 100, 1),
        },
        "distribution": [{"bucket": f"{int(edges[i] * 100)}–{int(edges[i + 1] * 100)}%", "customers": int(c)} for i, c in enumerate(hist)],
        "atRiskCustomers": int((current["churn"] >= 0.5).sum()),
        "atRiskRevenue": round(float(current.loc[current["churn"] >= 0.5, "monetary"].sum()), 2),
        "atRisk": [
            {
                "userId": int(uid),
                **who(int(uid)),
                "churnProbability": round(float(r.churn), 3),
                "lastOrderDays": int(r.recency),
                "orders": int(r.frequency),
                "lifetimeValue": round(float(r.monetary), 2),
                "segment": segments.get(uid) if segments is not None else None,
            }
            for uid, r in at_risk.iterrows()
        ],
        "featureImportance": sorted(
            [
                {"feature": CHURN_LABELS[f], "importance": round(float(v), 4)}
                for f, v in zip(CHURN_FEATURES, model.feature_importances_, strict=False)
            ],
            key=lambda x: -x["importance"],
        ),
    }
