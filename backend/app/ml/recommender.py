"""Personalised recommendations from shopper behaviour.

- For you: item-to-item collaborative filtering. Every view (1), add-to-cart (3) and purchase (5)
  builds a user x product matrix; products are similar when the same people engage with both.
  A shopper's score for a product = similarity to everything they engaged with, weighted by how strongly.
- Frequently bought together: products that appear in the same orders more often than chance (lift).
- Trending: products whose engagement in the last 7 days grew fastest versus the 3 weeks before.
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.metrics.pairwise import cosine_similarity

from .data import completed

WEIGHTS = {"view": 1.0, "add_to_cart": 3.0, "purchase": 5.0}


@dataclass
class RecommenderModel:
    products: list[str]
    users: dict[int, int]  # user id -> row
    matrix: np.ndarray  # users x products interaction strength
    similarity: np.ndarray  # products x products
    purchased: dict[int, set[str]]
    popularity: np.ndarray


def build(events: pd.DataFrame, product_ids: list[str]) -> RecommenderModel:
    index = {p: i for i, p in enumerate(product_ids)}
    ev = events[events["userId"].notna() & events["productId"].isin(index)] if not events.empty else events
    users = {int(u): i for i, u in enumerate(sorted(ev["userId"].unique()))} if not ev.empty else {}
    matrix = np.zeros((len(users), len(product_ids)))
    purchased: dict[int, set[str]] = {}
    if not ev.empty:
        weights = ev["type"].map(WEIGHTS).fillna(0).to_numpy()
        rows = ev["userId"].astype(int).map(users).to_numpy()
        cols = ev["productId"].map(index).to_numpy()
        np.add.at(matrix, (rows, cols), weights)
        for uid, pid in ev.loc[ev["type"] == "purchase", ["userId", "productId"]].itertuples(index=False):
            purchased.setdefault(int(uid), set()).add(pid)
    matrix = np.log1p(matrix)  # dampen heavy users so they don't dominate similarity
    similarity = cosine_similarity(matrix.T) if len(users) else np.zeros((len(product_ids), len(product_ids)))
    np.fill_diagonal(similarity, 0)
    return RecommenderModel(product_ids, users, matrix, similarity, purchased, matrix.sum(axis=0))


def for_user(model: RecommenderModel, user_id: int | None, k: int = 12) -> list[dict]:
    """[{productId, score, becauseOf}] - empty when we know nothing about the shopper (caller falls back to trending)."""
    if user_id is None or user_id not in model.users:
        return []
    profile = model.matrix[model.users[user_id]]
    scores = model.similarity @ profile
    owned = model.purchased.get(user_id, set())
    out = []
    for i in np.argsort(-scores):
        pid = model.products[i]
        if scores[i] <= 0 or len(out) >= k:
            break
        if pid in owned:  # already bought - recommend something new
            continue
        contributions = model.similarity[i] * profile
        out.append({"productId": pid, "score": round(float(scores[i]), 4), "becauseOf": model.products[int(np.argmax(contributions))]})
    return out


def similar_items(model: RecommenderModel, product_id: str, k: int = 6) -> list[str]:
    if product_id not in model.products:
        return []
    i = model.products.index(product_id)
    order = np.argsort(-model.similarity[i])
    return [model.products[j] for j in order[:k] if model.similarity[i, j] > 0]


def bought_together(sales: pd.DataFrame, product_id: str, k: int = 6, min_orders: int = 2) -> list[dict]:
    done = completed(sales)
    baskets = done.groupby("order_id")["product_id"].apply(set)
    baskets = baskets[baskets.apply(len) > 1]
    if baskets.empty:
        return []
    total = len(baskets)
    with_item = baskets[baskets.apply(lambda b: product_id in b)]
    if with_item.empty:
        return []
    pair_counts = pd.Series([p for b in with_item for p in b if p != product_id]).value_counts()
    item_counts = pd.Series([p for b in baskets for p in b]).value_counts()
    support_a = len(with_item) / total
    out = []
    for pid, together in pair_counts.items():
        if together < min_orders:
            continue
        lift = (together / total) / (support_a * item_counts[pid] / total)
        out.append({"productId": pid, "orders": int(together), "lift": round(float(lift), 2)})
    return sorted(out, key=lambda x: (-x["orders"], -x["lift"]))[:k]


def trending(events: pd.DataFrame, today: pd.Timestamp, k: int = 12, min_recent: int = 5) -> list[dict]:
    if events.empty:
        return []
    ev = events.assign(w=events["type"].map(WEIGHTS).fillna(0))
    recent = ev[ev["ts"] >= today - pd.Timedelta(days=7)].groupby("productId")["w"].sum()
    before = ev[(ev["ts"] < today - pd.Timedelta(days=7)) & (ev["ts"] >= today - pd.Timedelta(days=28))].groupby("productId")["w"].sum()
    frame = pd.DataFrame({"recent": recent, "before": before}).fillna(0)
    frame = frame[frame["recent"] >= min_recent]
    frame["growth"] = (frame["recent"] / 7) / (frame["before"] / 21 + 1)
    frame = frame.sort_values(["growth", "recent"], ascending=False).head(k)
    return [{"productId": pid, "growth": round(float(r.growth), 2), "recentEngagement": float(r.recent)} for pid, r in frame.iterrows()]
