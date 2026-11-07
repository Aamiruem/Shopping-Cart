"""The XGBoost ranker must prove itself on shoppers it never saw, and step aside when it can't."""

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("xgboost")

from app.ml import ranker  # noqa: E402
from app.ml.recommender import build  # noqa: E402

TZ = "Asia/Kolkata"
TODAY = pd.Timestamp("2026-06-01", tz=TZ)


def _shop(signal: bool, shoppers=160, seed=3):
    """Shoppers browse two categories. With `signal`, what they engage with later follows their category and price."""
    rng = np.random.default_rng(seed)
    ids = [f"p{i}" for i in range(80)]
    products = pd.DataFrame(
        {
            "product_id": ids,
            "category": ["fashion" if i < 40 else "home" for i in range(80)],
            "price": [500.0 + (i % 40) * 100 for i in range(80)],
        }
    )
    rows = []
    for user in range(shoppers):
        home = user % 2
        budget = rng.integers(0, 30)
        band = [(40 * home + budget + j) % 80 for j in range(10)]
        for _ in range(40):
            rows.append((user, ids[int(rng.choice(band))], "view", TODAY - pd.Timedelta(days=int(rng.integers(15, 70)))))
        for _ in range(12):
            pool = band if signal else range(80)
            rows.append((user, ids[int(rng.choice(pool))], "add_to_cart", TODAY - pd.Timedelta(days=int(rng.integers(1, 13)))))
    events = pd.DataFrame(rows, columns=["userId", "productId", "type", "ts"])
    return events, products


def test_ranker_is_only_used_when_it_beats_collaborative_filtering():
    events, products = _shop(signal=True)
    model = ranker.train(events, products, TODAY)
    assert model.metrics["testShoppers"] >= 10
    assert model.metrics["used"] == (model.metrics["ndcgXgboost"] > model.metrics["ndcgCollaborative"])
    assert (model.booster is not None) == model.metrics["used"]


def test_too_little_data_means_no_model():
    events, products = _shop(signal=True, shoppers=10)
    assert ranker.train(events, products, TODAY).booster is None


def test_no_events_means_no_model():
    _, products = _shop(signal=True, shoppers=2)
    assert ranker.train(pd.DataFrame(), products, TODAY).booster is None


def test_unproven_model_leaves_the_order_alone():
    events, products = _shop(signal=True, shoppers=8)
    cf = build(events, products["product_id"].tolist())
    picks = [{"productId": "p1", "score": 1.0}, {"productId": "p2", "score": 0.5}]
    unused = ranker.Ranker(None, {}, {}, {"used": False})
    assert ranker.rerank(unused, cf, 0, picks) == picks
