"""Seeds the catalog, demo accounts, sellers and ~6 months of realistic marketplace history.

    python -m scripts.seed                    # full demo data (recommended)
    python -m scripts.seed --customers 200 --days 120
    python -m scripts.seed --no-history       # catalog + accounts only

The simulated history is what makes the analytics and ML meaningful: it has a weekly rhythm,
a growth trend, two sale events, products that are rising or fading, customers with different
tastes and buying frequencies, and customers who lapse (churn). Everything generated here is
marked (users.is_synthetic, orders.source = 'seed', events.synthetic) so re-running replaces it
without touching real orders.
"""

import argparse
import asyncio
import json
import random
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from app.core.security import hash_password
from app.db.mongo import close_mongo, connect_mongo
from app.db.postgres import close_postgres, connect_postgres
from app.ml.support import triage
from app.ml.support_data import TRAINING_TICKETS

PRODUCTS_FILE = Path(__file__).resolve().parents[1] / "app" / "data" / "products.json"

ADMIN = {"name": "Admin", "email": "admin@shop.local", "password": "admin123", "role": "admin"}
DEMO = {"name": "Demo Shopper", "email": "demo@shop.local", "password": "demo123", "role": "customer"}
SELLERS = [
    {"name": "Arjun Mehta", "email": "seller@shop.local", "store": "TechHub Retail", "categories": ["mobiles", "electronics"]},
    {"name": "Priya Nair", "email": "style@shop.local", "store": "StyleStreet", "categories": ["fashion", "accessories", "beauty"]},
    {"name": "Rahul Verma", "email": "home@shop.local", "store": "HomeNest", "categories": ["home", "kitchen"]},
    {"name": "Sneha Iyer", "email": "fresh@shop.local", "store": "DailyFresh & Sports", "categories": ["grocery", "sports"]},
]
SELLER_PASSWORD = "seller123"
# Shopping hours are simulated in Indian Standard Time (no daylight saving, so a fixed offset is exact)
IST = timezone(timedelta(hours=5, minutes=30))

FIRST = [
    "Aarav",
    "Vivaan",
    "Aditya",
    "Vihaan",
    "Arjun",
    "Sai",
    "Reyansh",
    "Ayaan",
    "Krishna",
    "Ishaan",
    "Rohan",
    "Kabir",
    "Ananya",
    "Diya",
    "Aadhya",
    "Saanvi",
    "Pari",
    "Anika",
    "Navya",
    "Myra",
    "Sara",
    "Ira",
    "Meera",
    "Kavya",
    "Riya",
    "Neha",
    "Pooja",
    "Rahul",
    "Amit",
    "Sunil",
    "Deepak",
    "Karan",
    "Nikhil",
    "Farhan",
    "Imran",
    "Zoya",
    "Ayesha",
    "Harpreet",
    "Gurpreet",
    "Joseph",
]
LAST = [
    "Sharma",
    "Verma",
    "Gupta",
    "Singh",
    "Kumar",
    "Patel",
    "Shah",
    "Reddy",
    "Rao",
    "Nair",
    "Iyer",
    "Menon",
    "Das",
    "Bose",
    "Banerjee",
    "Chatterjee",
    "Mukherjee",
    "Khan",
    "Hussain",
    "Ali",
    "Joshi",
    "Kulkarni",
    "Deshmukh",
    "Pillai",
    "Fernandes",
    "Gill",
]
CITIES = [
    ("Bengaluru", "Karnataka", "560001", 18),
    ("Mumbai", "Maharashtra", "400001", 17),
    ("Delhi", "Delhi", "110001", 16),
    ("Hyderabad", "Telangana", "500001", 11),
    ("Chennai", "Tamil Nadu", "600001", 10),
    ("Pune", "Maharashtra", "411001", 9),
    ("Kolkata", "West Bengal", "700001", 7),
    ("Ahmedabad", "Gujarat", "380001", 5),
    ("Jaipur", "Rajasthan", "302001", 4),
    ("Lucknow", "Uttar Pradesh", "226001", 3),
]
WEEKDAY_FACTOR = [0.9, 0.85, 0.9, 0.95, 1.1, 1.35, 1.3]  # Mon..Sun
HOUR_WEIGHTS = np.array([1, 0.5, 0.3, 0.2, 0.2, 0.3, 0.8, 1.5, 2.5, 3, 3.5, 4, 5, 5.5, 4.5, 4, 4, 4.5, 5.5, 7, 8, 8.5, 6.5, 3])
CATEGORIES = ["mobiles", "electronics", "fashion", "accessories", "beauty", "home", "kitchen", "sports", "grocery"]
COMPLAINT_OPENERS = [
    "",
    "",
    "",
    "Hi, ",
    "Hello team, ",
    "This is really frustrating. ",
    "Please help urgently! ",
    "Very disappointed. ",
    "Thanks for the quick service earlier. ",
]


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------- catalog & accounts ----------


async def seed_catalog(db, seller_ids: dict[str, int], rng: random.Random) -> list[dict]:
    products = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    now = datetime.now(UTC)
    for p in products:
        p["sellerId"] = seller_ids[p["category"]]
        p["active"] = True
        p["createdAt"] = p["updatedAt"] = now - timedelta(days=rng.randint(150, 400))
    await db.products.delete_many({})
    result = await db.products.insert_many(products)
    for p, oid in zip(products, result.inserted_ids, strict=False):
        p["_id"] = oid
    await db.carts.delete_many({})
    await db.wishlists.delete_many({})
    log(f"Inserted {len(products)} products")
    return products


async def upsert_user(conn, name: str, email: str, password_hash: str, role: str) -> int:
    return await conn.fetchval(
        """INSERT INTO users (name, email, password_hash, role, email_verified) VALUES ($1, $2, $3, $4, TRUE)
           ON CONFLICT (email) DO UPDATE SET role = CASE WHEN users.role = 'admin' THEN users.role ELSE EXCLUDED.role END
           RETURNING id""",
        name,
        email,
        password_hash,
        role,
    )


async def seed_accounts(pool) -> tuple[int, dict[str, int]]:
    async with pool.acquire() as conn:
        await upsert_user(conn, ADMIN["name"], ADMIN["email"], hash_password(ADMIN["password"]), "admin")
        demo_id = await upsert_user(conn, DEMO["name"], DEMO["email"], hash_password(DEMO["password"]), "customer")
        seller_hash = hash_password(SELLER_PASSWORD)
        by_category = {}
        for s in SELLERS:
            uid = await upsert_user(conn, s["name"], s["email"], seller_hash, "seller")
            await conn.execute(
                """INSERT INTO sellers (user_id, store_name) VALUES ($1, $2)
                   ON CONFLICT (user_id) DO UPDATE SET store_name = EXCLUDED.store_name""",
                uid,
                s["store"],
            )
            by_category.update({c: uid for c in s["categories"]})
    log(f"admin: {ADMIN['email']} / {ADMIN['password']}")
    log(f"customer: {DEMO['email']} / {DEMO['password']}")
    for s in SELLERS:
        log(f"seller ({s['store']}): {s['email']} / {SELLER_PASSWORD}")
    return demo_id, by_category


# ---------- simulated history ----------


async def clear_history(pool, db) -> None:
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("DELETE FROM support_tickets WHERE user_id IN (SELECT id FROM users WHERE is_synthetic)")
        await conn.execute("DELETE FROM orders WHERE source = 'seed'")  # order_items cascade
        await conn.execute("DELETE FROM addresses WHERE user_id IN (SELECT id FROM users WHERE is_synthetic)")
        await conn.execute("DELETE FROM payment_otps WHERE user_id IN (SELECT id FROM users WHERE is_synthetic)")
        await conn.execute("DELETE FROM users WHERE is_synthetic")
    await db.events.delete_many({"synthetic": True})


def product_trends(products: list[dict], rng: np.random.Generator) -> np.ndarray:
    """Per-product popularity multiplier at time t (0..1): some products rise, some fade, most are steady."""
    kind = rng.choice(["steady", "rising", "fading"], size=len(products), p=[0.65, 0.2, 0.15])
    strength = rng.uniform(1.5, 4.0, size=len(products))
    return np.array([{"steady": 0.0, "rising": 1.0, "fading": -1.0}[k] for k in kind]) * np.log(strength)


async def seed_history(pool, db, products: list[dict], demo_id: int, n_customers: int, days: int, seed: int) -> None:
    rng = np.random.default_rng(seed)
    pyrng = random.Random(seed)
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    # Local midnight `days` ago: day d of the simulation is a calendar day in India, ending yesterday
    start = (datetime.now(IST) - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)

    by_category: dict[str, list[int]] = {c: [] for c in CATEGORIES}
    for i, p in enumerate(products):
        by_category[p["category"]].append(i)
    # Popularity: well-reviewed products sell more, and cheaper products sell more often (price elasticity)
    base_pop = np.array([np.sqrt(p.get("ratingCount", 100)) * max(p.get("rating", 3), 1) * (p["price"] / 1000) ** -0.6 for p in products])
    trend_log = product_trends(products, rng)

    # Customers
    password_hash = hash_password("customer123")
    city_weights = np.array([c[3] for c in CITIES], dtype=float)
    customers = []
    for i in range(n_customers):
        first, last = pyrng.choice(FIRST), pyrng.choice(LAST)
        city = CITIES[rng.choice(len(CITIES), p=city_weights / city_weights.sum())]
        signup = int(rng.integers(0, days - 10)) if rng.random() < 0.7 else 0  # 30% were customers before the window
        churned = rng.random() < 0.38
        active_until = int(rng.integers(signup + 15, days + 1)) if churned and signup + 15 < days else days
        prefs = list(rng.choice(CATEGORIES, size=int(rng.integers(1, 4)), replace=False))
        rate = float(np.clip(rng.lognormal(mean=np.log(1 / 22), sigma=0.6), 1 / 90, 1 / 4))  # orders per day
        buyer = rng.random() >= 0.35  # about a third of registered shoppers browse but never buy
        customers.append(
            {
                "name": f"{first} {last}",
                "email": f"{first.lower()}.{last.lower()}{i}@customers.example",
                "city": city,
                "signup": signup,
                "active_until": active_until,
                "prefs": prefs,
                "rate": rate,
                "buyer": buyer,
            }
        )
    demo = {
        "id": demo_id,
        "name": DEMO["name"],
        "city": CITIES[0],
        "signup": 20,
        "active_until": days,
        "prefs": ["mobiles", "electronics"],
        "rate": 1 / 12,
        "buyer": True,
    }

    async with pool.acquire() as conn:
        ids = await conn.fetch(
            """INSERT INTO users (name, email, password_hash, role, city, is_synthetic, email_verified, created_at)
               SELECT n, e, $3, 'customer', c, TRUE, TRUE, ts
                 FROM unnest($1::text[], $2::text[], $4::text[], $5::timestamptz[]) AS t(n, e, c, ts)
               RETURNING id""",
            [c["name"] for c in customers],
            [c["email"] for c in customers],
            password_hash,
            [c["city"][0] for c in customers],
            [start + timedelta(days=c["signup"]) for c in customers],
        )
    for c, r in zip(customers, ids, strict=False):
        c["id"] = r["id"]
    customers.append(demo)

    # Day-level demand multiplier: growth trend x weekday x sale events
    day_factor = np.empty(days)
    for d in range(days):
        date = start + timedelta(days=d)
        sale = 2.2 if days - 66 <= d < days - 59 else 1.6 if days - 23 <= d < days - 19 else 1.0
        day_factor[d] = (0.8 + 0.5 * d / days) * WEEKDAY_FACTOR[date.weekday()] * sale

    next_order = (await pool.fetchval("SELECT COALESCE(MAX(id), 0) FROM orders")) + 1
    orders, items, events = [], [], []
    hour_p = HOUR_WEIGHTS / HOUR_WEIGHTS.sum()

    def pick_product(prefs: list[str], t: float) -> int:
        category = pyrng.choice(prefs) if rng.random() < 0.8 else pyrng.choice(CATEGORIES)
        pool_idx = by_category[category]
        weights = base_pop[pool_idx] * np.exp(trend_log[pool_idx] * t)
        return pool_idx[int(rng.choice(len(pool_idx), p=weights / weights.sum()))]

    def event(kind: str, uid: int, idx: int, ts: datetime, qty: int = 1, order_id: int | None = None) -> dict:
        p = products[idx]
        doc = {
            "type": kind,
            "userId": uid,
            "productId": str(p["_id"]),
            "category": p["category"],
            "sellerId": p["sellerId"],
            "price": p["price"],
            "qty": qty,
            "ts": ts,
            "synthetic": True,
        }
        if order_id:
            doc["orderId"] = order_id
        return doc

    for c in customers:
        city, state, pincode, _ = c["city"]
        street = f"{pyrng.randint(1, 250)} {pyrng.choice(['MG Road', 'Station Road', 'Park Street', 'Main Road', 'Ring Road'])}"
        address = f"{c['name']}, {street}, {city}, {state} - {pincode}. Phone: 9{pyrng.randint(100000000, 999999999)}"
        for d in range(c["signup"], c["active_until"]):
            t = d / days
            # Browsing without buying (feeds the funnel and recommendations)
            for _ in range(rng.poisson(c["rate"] * 2.5 * day_factor[d])):
                idx = pick_product(c["prefs"], t)
                ts = start + timedelta(days=d, hours=int(rng.choice(24, p=hour_p)), minutes=int(rng.integers(60)))
                events.append(event("view", c["id"], idx, ts))
                if rng.random() < 0.18:
                    events.append(event("add_to_cart", c["id"], idx, ts + timedelta(minutes=2)))

            if not c["buyer"] or rng.random() >= min(c["rate"] * day_factor[d], 0.9):
                continue
            ts = start + timedelta(days=d, hours=int(rng.choice(24, p=hour_p)), minutes=int(rng.integers(60)))
            order_id = next_order
            next_order += 1
            n_items = int(rng.choice([1, 2, 3], p=[0.62, 0.28, 0.10]))
            chosen = {pick_product(c["prefs"], t) for _ in range(n_items)}
            cancelled = rng.random() < 0.06
            subtotal = 0.0
            for idx in chosen:
                p = products[idx]
                qty = int(rng.choice([1, 2, 3], p=[0.86, 0.11, 0.03]))
                subtotal += p["price"] * qty
                items.append((order_id, str(p["_id"]), p["name"], float(p["price"]), qty, p["image"], p["sellerId"], p["category"]))
                for v in range(int(rng.integers(1, 5))):
                    events.append(event("view", c["id"], idx, ts - timedelta(hours=int(rng.integers(1, 72)), minutes=v)))
                events.append(event("add_to_cart", c["id"], idx, ts - timedelta(minutes=int(rng.integers(3, 40)))))
                if not cancelled:
                    events.append(event("purchase", c["id"], idx, ts, qty, order_id))
            fee = 0.0 if subtotal >= 499 else 40.0
            payment = str(rng.choice(["upi", "card", "cod"], p=[0.55, 0.2, 0.25]))
            orders.append((order_id, c["id"], subtotal + fee, "cancelled" if cancelled else "placed", address, ts, payment, fee))

    async with pool.acquire() as conn, conn.transaction():
        await conn.executemany(
            """INSERT INTO orders (id, user_id, total, status, address, created_at, payment_method, delivery_fee, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed')""",
            orders,
        )
        await conn.executemany(
            """INSERT INTO order_items (order_id, product_id, name, price, qty, image, seller_id, category)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
            items,
        )
        await conn.execute("SELECT setval(pg_get_serial_sequence('orders', 'id'), (SELECT MAX(id) FROM orders))")
    for i in range(0, len(events), 5000):
        await db.events.insert_many(events[i : i + 5000], ordered=False)
    log(
        f"Simulated {len(customers)} customers, {len(orders)} orders, {len(items)} order lines, "
        f"{len(events)} behaviour events over {days} days"
    )

    # Make some fast movers low on stock so restock alerts have something to show
    rising = [i for i in np.argsort(-trend_log)[:25]]
    for i in rising[::2]:
        await db.products.update_one({"_id": products[i]["_id"]}, {"$set": {"stock": int(rng.integers(3, 25))}})

    await seed_tickets(pool, customers[:-1], orders, rng, pyrng, now, days)


async def seed_tickets(pool, customers, orders, rng, pyrng, now, days) -> None:
    orders_by_user: dict[int, list[int]] = {}
    for o in orders:
        orders_by_user.setdefault(o[1], []).append(o[0])
    rows = []
    for _ in range(min(320, len(customers))):
        c = pyrng.choice(customers)
        text, _ = pyrng.choice(TRAINING_TICKETS)
        message = pyrng.choice(COMPLAINT_OPENERS) + text + pyrng.choice([".", "!", ". Please check.", ". Waiting for your reply.", "!!"])
        order_id = pyrng.choice(orders_by_user[c["id"]]) if c["id"] in orders_by_user and rng.random() < 0.7 else None
        result = triage(text[:60], message, c["name"], order_id)
        created = now - timedelta(days=float(rng.uniform(0, min(days, 75))), hours=float(rng.uniform(0, 24)))
        age_days = (now - created).days
        status = "resolved" if age_days > 6 or rng.random() < 0.4 else pyrng.choice(["open", "in_progress"])
        resolved = (
            created + timedelta(hours=float(rng.uniform(1, 30 if result["priority"] == "high" else 72))) if status == "resolved" else None
        )
        rows.append(
            (
                c["id"],
                order_id,
                text[:60],
                message,
                result["category"],
                result["confidence"],
                result["sentiment"],
                result["priority"],
                status,
                result["suggestedReply"],
                created,
                resolved,
            )
        )
    await pool.executemany(
        """INSERT INTO support_tickets (user_id, order_id, subject, message, category, category_confidence, sentiment, priority,
                                        status, suggested_reply, created_at, resolved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)""",
        rows,
    )
    log(f"Created {len(rows)} support tickets (auto-triaged by the ML model)")


async def main(args) -> None:
    pool = await connect_postgres()
    db = await connect_mongo()
    try:
        demo_id, seller_ids = await seed_accounts(pool)
        products = await seed_catalog(db, seller_ids, random.Random(args.seed))
        await clear_history(pool, db)
        if not args.no_history:
            await seed_history(pool, db, products, demo_id, args.customers, args.days, args.seed)
    finally:
        await close_mongo()
        await close_postgres()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--customers", type=int, default=650)
    parser.add_argument("--days", type=int, default=180)
    parser.add_argument("--seed", type=int, default=42, help="random seed (same seed = same data)")
    parser.add_argument("--no-history", action="store_true", help="only catalog and demo accounts")
    asyncio.run(main(parser.parse_args()))
