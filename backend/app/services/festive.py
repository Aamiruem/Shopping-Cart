"""The festive home section: which festival or season it is in India, its collections, and what shoppers want now.

Same output as api/_demand.mjs festiveStore, from the same data/seasons.json. Demand comes from behaviour events
in MongoDB (purchases count most, then add-to-carts, then views), with older activity fading (half-life ~5 days).
Until there's enough activity, catalog popularity carries the ranking; real demand takes over as it grows.
"""

import json
import math
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from ..db.mongo import get_db
from .catalog import serialize_product

SEASON_FILE = Path(__file__).resolve().parents[1] / "data" / "seasons.json"
PRICE_CAPS = [299, 499, 699, 999, 1499, 1999, 2999, 4999, 9999]
MIN_IN_COLLECTION = 4
DECAY_SECONDS = 7 * 24 * 60 * 60
WEIGHTS = {"purchase": 5.0, "add_to_cart": 2.0, "view": 0.5}
INDIA = ZoneInfo("Asia/Kolkata")


def _data() -> dict:
    return json.loads(SEASON_FILE.read_text(encoding="utf-8"))


def current_season(now: datetime | None = None) -> dict:
    day = (now or datetime.now(UTC)).astimezone(INDIA).date().isoformat()
    data = _data()
    festival = next((f for f in data["festivals"] if f["from"] <= day <= f["to"]), None)
    if festival:
        return {**festival, "kind": "festival", "endsOn": festival["to"]}
    month = int(day[5:7])
    season = next(s for s in data["seasons"] if month in s["months"])
    return {**season, "kind": "season", "endsOn": None}


async def demand_scores(now: datetime | None = None) -> dict[str, float]:
    now = now or datetime.now(UTC)
    scores: dict[str, float] = {}
    cursor = get_db().events.find(
        {"ts": {"$gte": now - timedelta(days=60)}, "type": {"$in": list(WEIGHTS)}}, {"productId": 1, "type": 1, "qty": 1, "ts": 1}
    )
    async for e in cursor:
        ts = e["ts"] if e["ts"].tzinfo else e["ts"].replace(tzinfo=UTC)
        qty = (e.get("qty") or 1) if e["type"] != "view" else 1
        weight = WEIGHTS[e["type"]] * qty
        scores[e["productId"]] = scores.get(e["productId"], 0.0) + weight * math.exp(-(now - ts).total_seconds() / DECAY_SECONDS)
    return scores


def rank_by_demand(products: list[dict], demand: dict[str, float], popularity_scale: float) -> list[dict]:
    """The weight on real activity grows with how much there is (none: popularity only; 50+ weighted actions: 80%)."""
    top = max(demand.values(), default=0)
    trust = min(0.8, sum(demand.values()) / 50 * 0.8)

    def score(p: dict) -> float:
        popularity = math.log1p(p.get("ratingCount") or 0) / popularity_scale
        return ((demand.get(str(p["_id"]), 0) / top) if top else 0) * trust + popularity * (1 - trust)

    return sorted((p for p in products if (p.get("stock") or 0) > 0), key=score, reverse=True)


def _query(params: dict) -> dict:
    query: dict = {"active": {"$ne": False}, "stock": {"$gt": 0}}
    if params.get("category"):
        query["category"] = params["category"]
    if params.get("subCategory"):
        query["subCategory"] = params["subCategory"]
    if params.get("q"):
        pattern = re.compile(re.escape(params["q"]), re.I)
        query["$or"] = [{"name": pattern}, {"brand": pattern}, {"category": pattern}, {"subCategory": pattern}, {"tags": pattern}]
    return query


async def festive_store(now: datetime | None = None) -> dict:
    db = get_db()
    signal = "demand"
    try:
        demand = await demand_scores(now)
    except Exception:  # noqa: BLE001 - the section still shows, ranked by popularity
        demand = {}
    if not demand:
        signal = "popularity"
    most = await db.products.find_one({}, {"ratingCount": 1}, sort=[("ratingCount", -1)])
    scale = math.log1p(max(1, (most or {}).get("ratingCount") or 1))

    season = current_season(now)
    collections, in_season = [], {}
    for definition in season["collections"]:
        found = [p async for p in db.products.find(_query(definition["params"])).limit(400)]
        for p in found:
            in_season[str(p["_id"])] = p
        if len(found) < MIN_IN_COLLECTION:
            continue
        # The lowest round price that still has a real choice of products under it
        cap = next((c for c in PRICE_CAPS if sum(p["price"] <= c for p in found) >= MIN_IN_COLLECTION), None)
        items = rank_by_demand([p for p in found if cap is None or p["price"] <= cap], demand, scale)
        params = {**definition["params"], **({"maxPrice": cap} if cap else {}), "sort": "popularity"}
        collections.append(
            {
                "id": definition["id"],
                "title": definition["title"],
                "under": cap,
                "count": len(items),
                "to": f"/products?{urlencode(params)}",
                "images": [{"src": p.get("image"), "alt": p["name"]} for p in items[:4]],
            }
        )
    trending = [serialize_product(p) for p in rank_by_demand(list(in_season.values()), demand, scale)[:14]]
    about = {k: v for k, v in season.items() if k not in ("collections", "months", "from", "to")}
    return {"season": about, "collections": collections, "trending": trending, "signal": signal}
