"""XGBoost learning-to-rank on top of collaborative filtering.

Collaborative filtering finds candidates. XGBoost then orders them using more signals: how close the price is to what
the shopper usually spends, how much they like the category, and how popular the product is.

It's trained on behaviour before a cutoff date and tested on what the same kind of shoppers actually did after it. If
it doesn't beat collaborative filtering on shoppers it never saw, it isn't used.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.metrics import ndcg_score

try:
    import xgboost as xgb
except Exception:  # not installed, or its native library can't load (e.g. blocked by Windows Smart App Control)
    xgb = None

from .recommender import WEIGHTS, RecommenderModel, build
from .tracking import tracked_run

FEATURES = ["cf_score", "popularity", "category_affinity", "price_ratio"]
CANDIDATES = 60
HOLDOUT_DAYS = 14
MIN_USERS = 30
TEST_SHARE = 0.25
TOP_K = 10


@dataclass
class Ranker:
    booster: xgb.XGBRanker | None
    categories: dict[str, str]
    prices: dict[str, float]
    metrics: dict


def _candidates(model: RecommenderModel, user_id: int, n: int = CANDIDATES) -> tuple[list[str], np.ndarray]:
    scores = model.similarity @ model.matrix[model.users[user_id]]
    owned = model.purchased.get(user_id, set())
    order = [i for i in np.argsort(-scores) if scores[i] > 0 and model.products[i] not in owned][:n]
    return [model.products[i] for i in order], scores[order]


def _features(model: RecommenderModel, user_id: int, products: list[str], scores: np.ndarray, categories: dict, prices: dict) -> np.ndarray:
    profile = model.matrix[model.users[user_id]]
    engaged = np.nonzero(profile)[0]
    spent = {}
    for i in engaged:
        category = categories.get(model.products[i], "")
        spent[category] = spent.get(category, 0.0) + profile[i]
    total = sum(spent.values()) or 1.0
    typical = np.average([prices.get(model.products[i], 0.0) for i in engaged], weights=profile[engaged]) if len(engaged) else 0.0
    index = {p: i for i, p in enumerate(model.products)}
    popularity = np.log1p(model.popularity)
    return np.array(
        [
            [
                score,
                popularity[index[p]],
                spent.get(categories.get(p, ""), 0.0) / total,
                prices.get(p, 0.0) / typical if typical else 1.0,
            ]
            for p, score in zip(products, scores, strict=True)
        ]
    )


def _ndcg(relevance: list[np.ndarray], predicted: list[np.ndarray]) -> float:
    scores = [ndcg_score([r], [p], k=TOP_K) for r, p in zip(relevance, predicted, strict=True) if r.sum() > 0]
    return float(np.mean(scores)) if scores else 0.0


def train(events: pd.DataFrame, products: pd.DataFrame, today: pd.Timestamp) -> Ranker:
    categories = dict(zip(products["product_id"], products["category"], strict=True))
    prices = dict(zip(products["product_id"], products["price"].astype(float), strict=True))
    unused = Ranker(None, categories, prices, {"used": False})
    if xgb is None:  # without XGBoost, the collaborative-filtering order stands
        return Ranker(None, categories, prices, {"used": False, "reason": "xgboost unavailable"})
    if events.empty:
        return unused
    known = events[events["userId"].notna()]
    cutoff = today - pd.Timedelta(days=HOLDOUT_DAYS)
    past, future = known[known["ts"] < cutoff], known[known["ts"] >= cutoff]
    model = build(past, products["product_id"].tolist())

    engaged_later = future.assign(weight=future["type"].map(WEIGHTS).fillna(0)).groupby(["userId", "productId"])["weight"].sum()
    rows = []
    for user in sorted({int(u) for u in future["userId"].unique()} & set(model.users)):
        items, scores = _candidates(model, user)
        if not items or user not in engaged_later.index.get_level_values(0):
            continue
        later = engaged_later.loc[user]
        relevance = np.array([float(later.get(p, 0.0)) for p in items])
        if relevance.sum() > 0:
            rows.append((_features(model, user, items, scores, categories, prices), np.minimum(relevance, 5), scores))
    if len(rows) < MIN_USERS:
        return unused

    # Test on shoppers the model never saw in training
    split = int(len(rows) * (1 - TEST_SHARE))
    fit, test = rows[:split], rows[split:]
    groups = np.concatenate([np.full(len(r[0]), i) for i, r in enumerate(fit)])
    booster = xgb.XGBRanker(objective="rank:ndcg", n_estimators=120, max_depth=3, learning_rate=0.1, subsample=0.8, random_state=42)
    booster.fit(np.vstack([r[0] for r in fit]), np.concatenate([r[1] for r in fit]), qid=groups)

    relevance = [r[1] for r in test]
    with_cf = _ndcg(relevance, [r[2] for r in test])
    with_xgb = _ndcg(relevance, [booster.predict(r[0]) for r in test])
    better = with_xgb > with_cf
    metrics = {"used": better, "ndcgXgboost": round(with_xgb, 4), "ndcgCollaborative": round(with_cf, 4), "testShoppers": len(test)}
    with tracked_run("for-you-ranker", {"features": ",".join(FEATURES), "shoppers": len(rows)}) as log_metrics:
        log_metrics({"ndcg_xgboost": with_xgb, "ndcg_collaborative": with_cf})
    return Ranker(booster if better else None, categories, prices, metrics)


def rerank(ranker: Ranker, model: RecommenderModel, user_id: int, picks: list[dict]) -> list[dict]:
    """Orders the collaborative-filtering picks. Without a proven model they keep their original order."""
    if ranker.booster is None or len(picks) < 2:
        return picks
    items = [p["productId"] for p in picks]
    scores = np.array([p["score"] for p in picks])
    predicted = ranker.booster.predict(_features(model, user_id, items, scores, ranker.categories, ranker.prices))
    return [picks[i] for i in np.argsort(-predicted)]
