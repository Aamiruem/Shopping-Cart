"""Shared fixtures: a small simulated shop (pure pandas, no database) for the ML unit tests."""

import numpy as np
import pandas as pd
import pytest

TZ = "Asia/Kolkata"


@pytest.fixture(scope="session")
def shop():
    """120 days of sales for 40 products and 300 customers, with a weekly pattern, growth,
    a rising product group and customers who stop buying halfway through."""
    rng = np.random.default_rng(7)
    today = pd.Timestamp.now(tz=TZ).normalize()
    days = pd.date_range(today - pd.Timedelta(days=120), today - pd.Timedelta(days=1), freq="D", tz=TZ)

    products = pd.DataFrame(
        {
            "product_id": [f"p{i}" for i in range(40)],
            "name": [f"Product {i}" for i in range(40)],
            "category": [["mobiles", "fashion", "home", "grocery"][i % 4] for i in range(40)],
            "image": "",
            "brand": "Brand",
            "price": rng.uniform(200, 5000, 40).round(),
            "rating": rng.uniform(3, 5, 40).round(1),
            "ratingCount": rng.integers(10, 2000, 40),
            "stock": rng.integers(5, 200, 40),
            "sellerId": 1,
            "active": True,
        }
    )
    products["mrp"] = (products["price"] * 1.2).round()
    popularity = rng.uniform(0.5, 2, 40)
    rising = np.zeros(40)
    rising[:8] = 1.5  # products 0-7 get steadily more popular

    lines, events = [], []
    order_id = 0
    for user in range(300):
        churn_day = rng.integers(25, 65) if user % 3 == 0 else 999  # a third of customers lapse before the last 45 days
        rate = rng.uniform(0.05, 0.15)
        for d, day in enumerate(days):
            t = d / len(days)
            weekday = 1.4 if day.dayofweek >= 5 else 1.0
            if rng.random() < rate * 0.5:
                events.append({"type": "view", "userId": user, "productId": f"p{rng.integers(40)}", "ts": day + pd.Timedelta(hours=12)})
            if d > churn_day or rng.random() >= rate * weekday * (0.8 + 0.4 * t):
                continue
            order_id += 1
            weights = popularity * np.exp(rising * t)
            pid = int(rng.choice(40, p=weights / weights.sum()))
            qty = int(rng.integers(1, 3))
            ts = day + pd.Timedelta(hours=int(rng.integers(8, 23)))
            lines.append(
                {
                    "order_id": order_id,
                    "product_id": f"p{pid}",
                    "seller_id": 1,
                    "category": products.at[pid, "category"],
                    "name": products.at[pid, "name"],
                    "price": float(products.at[pid, "price"]),
                    "qty": qty,
                    "user_id": user,
                    "created_at": ts,
                    "status": "cancelled" if rng.random() < 0.05 else "placed",
                    "payment_method": "upi",
                    "city": "Pune",
                }
            )
            for kind in ("view", "add_to_cart", "purchase"):
                events.append({"type": kind, "userId": user, "productId": f"p{pid}", "ts": ts - pd.Timedelta(minutes=5)})

    sales = pd.DataFrame(lines)
    sales["revenue"] = sales["price"] * sales["qty"]
    sales["date"] = sales["created_at"].dt.normalize()
    events = pd.DataFrame(events)
    events["qty"] = 1
    events["date"] = events["ts"].dt.normalize()
    users = pd.DataFrame(
        {
            "user_id": range(300),
            "name": [f"User {i}" for i in range(300)],
            "email": [f"user{i}@example.com" for i in range(300)],
            "city": "Pune",
        }
    )
    return {"sales": sales, "products": products, "events": events, "users": users, "today": today}
