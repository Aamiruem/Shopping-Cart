"""Growth advisor: per-product analytics and concrete actions that help sellers earn more.

For every product it combines 30-day demand (views -> add to cart -> purchase, vs the 30 days before),
conversion against similar products, price against the median of similar products, a listing
quality score and days of stock left, then ranks the products by the money each tip could unlock.
All of it is explainable arithmetic over the store's own data (no black box), so sellers can trust it.
"""

import math

import numpy as np
import pandas as pd

WINDOW = 30


def listing_score(p: dict) -> tuple[int, list[str]]:
    """0-100: how complete and persuasive the listing is, plus the fixes that would raise it."""
    score, fixes = 0, []
    photos = len(p.get("images") or ([p["image"]] if p.get("image") else []))
    if photos >= 3:
        score += 25
    elif photos:
        score += 12
        fixes.append(
            f"Add {3 - photos} more photo{'s' if 3 - photos > 1 else ''} (front, back, in use): listings with 3+ photos convert better"
        )
    else:
        fixes.append("Add product photos")
    desc = len((p.get("description") or "").strip())
    if desc >= 150:
        score += 20
    elif desc >= 60:
        score += 10
        fixes.append("Write a fuller description (150+ characters): material, size, what's in the box, care")
    else:
        fixes.append("Add a description that answers shoppers' questions (150+ characters)")
    if p.get("videos"):
        score += 15
    else:
        fixes.append("Add a short video: shoppers who see the product in motion buy with more confidence")
    if len(p.get("images360") or []) >= 4:
        score += 10
    elif p.get("category") in ("fashion", "accessories", "electronics"):
        fixes.append("Add a 360° view (4+ photos while turning the product)")
    if len(p.get("tags") or []) >= 3:
        score += 10
    else:
        fixes.append("Add 3+ search tags (e.g. colour, material, use) so the product shows up in more searches")
    if p.get("brand"):
        score += 5
    else:
        fixes.append("Fill in the brand")
    if p.get("mrp") and p["mrp"] > p.get("price", 0):
        score += 10
    else:
        fixes.append("Show the MRP so shoppers see the discount")
    if p.get("unit") or p.get("category") not in ("grocery", "beauty"):
        score += 5
    else:
        fixes.append("Add the pack size (e.g. 500 g, 1 L)")
    return min(score, 100), fixes


def _counts(events: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    if events.empty:
        return pd.DataFrame(columns=["view", "add_to_cart", "purchase"])
    window = events[(events["date"] >= start) & (events["date"] < end)]
    table = window.pivot_table(index="productId", columns="type", values="ts", aggfunc="count", fill_value=0)
    for col in ("view", "add_to_cart", "purchase"):
        if col not in table:
            table[col] = 0
    return table[["view", "add_to_cart", "purchase"]]


def growth_report(products: list[dict], peers: pd.DataFrame, sales: pd.DataFrame, events: pd.DataFrame, today: pd.Timestamp) -> dict:
    start, prev_start = today - pd.Timedelta(days=WINDOW), today - pd.Timedelta(days=2 * WINDOW)
    now_counts, prev_counts = _counts(events, start, today + pd.Timedelta(days=1)), _counts(events, prev_start, start)
    recent_sales = sales[(sales["date"] >= start) & (sales["status"] != "cancelled")] if not sales.empty else sales
    revenue = recent_sales.groupby("product_id")["revenue"].sum() if not recent_sales.empty else pd.Series(dtype=float)
    units = recent_sales.groupby("product_id")["qty"].sum() if not recent_sales.empty else pd.Series(dtype=float)

    # Benchmarks from similar products across the marketplace
    peers = peers.copy()
    peers["group"] = peers["category"].fillna("") + "/" + peers["subCategory"].fillna("")
    median_price = peers.groupby("group")["price"].median()
    all_counts = _counts(events, start, today + pd.Timedelta(days=1))
    conv = (all_counts["purchase"] / all_counts["view"].replace(0, np.nan)).dropna()
    market_conversion = float(conv[all_counts.loc[conv.index, "view"] >= 5].median()) if len(conv) else 0.03
    market_conversion = market_conversion if market_conversion > 0 and not math.isnan(market_conversion) else 0.03

    rows = []
    for p in products:
        pid = str(p["_id"])
        c = now_counts.loc[pid] if pid in now_counts.index else pd.Series({"view": 0, "add_to_cart": 0, "purchase": 0})
        prev = prev_counts.loc[pid] if pid in prev_counts.index else pd.Series({"view": 0, "add_to_cart": 0, "purchase": 0})
        views, carts, buys = int(c["view"]), int(c["add_to_cart"]), int(c["purchase"])
        conversion = buys / views if views else 0.0
        cart_rate = carts / views if views else 0.0
        demand_change = (views - int(prev["view"])) / int(prev["view"]) if int(prev["view"]) else (1.0 if views else 0.0)
        group = f"{p.get('category', '')}/{p.get('subCategory', '')}"
        peer_price = float(median_price.get(group, p["price"]))
        price_gap = (p["price"] - peer_price) / peer_price if peer_price else 0.0
        sold30 = float(units.get(pid, 0))
        daily = sold30 / WINDOW
        days_left = (p.get("stock", 0) / daily) if daily > 0 else None
        score, fixes = listing_score(p)
        avg_price = float(p["price"])

        tips: list[dict] = []
        if p.get("stock", 0) == 0:
            tips.append(
                {
                    "kind": "stock",
                    "text": "Out of stock: every visit is a lost sale. Restock now.",
                    "value": round(views / WINDOW * 7 * max(conversion, market_conversion) * avg_price),
                }
            )
        elif days_left is not None and days_left < 14:
            tips.append(
                {
                    "kind": "stock",
                    "text": f"Selling fast: about {math.ceil(days_left)} days of stock left. "
                    f"Restock ~{math.ceil(daily * 30)} units for next month.",
                    "value": round(daily * 14 * avg_price),
                }
            )
        if views >= 20 and conversion < market_conversion * 0.6 and price_gap > 0.15:
            target = round(peer_price * 1.05 / 10) * 10 - 1
            tips.append(
                {
                    "kind": "price",
                    "text": f"Price is {round(price_gap * 100)}% above similar products and few viewers buy. "
                    f"Try ₹{target:,} (similar items sell around ₹{round(peer_price):,}).",
                    "value": round(views * (market_conversion - conversion) * target),
                }
            )
        elif views >= 20 and cart_rate >= 0.08 and conversion < market_conversion * 0.6:
            tips.append(
                {
                    "kind": "checkout",
                    "text": "Shoppers add it to cart but don't buy: offer free delivery or a small bundle discount.",
                    "value": round(carts * 0.2 * avg_price),
                }
            )
        elif views >= 20 and cart_rate < 0.03:
            tips.append(
                {
                    "kind": "listing",
                    "text": "Many views but few add-to-carts: better photos, a clearer title and the key benefits "
                    "up front usually fix this.",
                    "value": round(views * market_conversion * 0.3 * avg_price),
                }
            )
        if conversion > market_conversion * 1.5 and views >= 10 and price_gap < -0.1:
            tips.append(
                {
                    "kind": "price",
                    "text": f"Converts well and is priced {abs(round(price_gap * 100))}% below similar items: "
                    "you can likely raise the price a little without losing sales.",
                    "value": round(buys * avg_price * 0.05),
                }
            )
        if views < 10 and p.get("active", True):
            tips.append(
                {
                    "kind": "visibility",
                    "text": "Hardly anyone sees this product: add search tags and a keyword-rich title (brand + type + key feature).",
                    "value": round(30 * market_conversion * avg_price),
                }
            )
        if demand_change >= 0.3 and views >= 10:
            tips.append(
                {
                    "kind": "trend",
                    "text": f"Demand is up {round(demand_change * 100)}% on last month: keep it in stock and consider featuring it.",
                    "value": round(daily * 7 * avg_price),
                }
            )
        for fix in fixes[:2]:
            tips.append({"kind": "listing", "text": fix, "value": round(max(views, 10) * market_conversion * 0.1 * avg_price)})

        tips.sort(key=lambda t: -t["value"])
        rows.append(
            {
                "productId": pid,
                "name": p["name"],
                "image": p.get("image"),
                "category": p.get("category"),
                "price": avg_price,
                "stock": p.get("stock", 0),
                "active": p.get("active", True),
                "views": views,
                "addToCarts": carts,
                "purchases": buys,
                "conversion": round(conversion, 4),
                "cartRate": round(cart_rate, 4),
                "demandChange": round(demand_change, 3),
                "revenue30": round(float(revenue.get(pid, 0))),
                "unitsSold30": int(sold30),
                "peerPrice": round(peer_price),
                "priceGap": round(price_gap, 3),
                "daysOfStock": None if days_left is None else round(days_left, 1),
                "listingScore": score,
                "tips": tips[:4],
                "opportunity": sum(t["value"] for t in tips[:4]),
            }
        )

    rows.sort(key=lambda r: -r["opportunity"])
    active = [r for r in rows if r["active"]]
    total_views = sum(r["views"] for r in rows)
    total_buys = sum(r["purchases"] for r in rows)
    return {
        "summary": {
            "products": len(rows),
            "avgListingScore": round(np.mean([r["listingScore"] for r in rows])) if rows else 0,
            "revenue30": sum(r["revenue30"] for r in rows),
            "views30": total_views,
            "conversion": round(total_buys / total_views, 4) if total_views else 0,
            "marketConversion": round(market_conversion, 4),
            "needsAttention": sum(1 for r in active if r["tips"]),
            "outOfStock": sum(1 for r in active if r["stock"] == 0),
            "opportunity": sum(r["opportunity"] for r in rows[:20]),
        },
        "products": rows,
    }
