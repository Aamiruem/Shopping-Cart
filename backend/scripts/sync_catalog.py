"""Bring an existing store up to date with app/data/products.json without re-seeding.

Unlike scripts.seed this keeps product ids, so carts, wishlists and orders stay intact:
  - products missing from the database are inserted (owned by the seller for their category)
  - existing products (matched by name) only get catalog fields they lack, such as `audience`,
    `images360` or `unit`, and lose first-seed placeholders (LEGACY_VALUES); prices, stock and seller
    edits are never overwritten

    python -m scripts.sync_catalog
"""

import asyncio
import json
from datetime import UTC, datetime

from app.db.mongo import close_mongo, connect_mongo
from app.db.postgres import close_postgres, connect_postgres
from scripts.seed import PRODUCTS_FILE, SELLERS

# Fields added to the catalog after the first seed; filled in on existing products when missing
NEW_FIELDS = ("audience", "images360", "unit", "imageCredit")
# Placeholder values from the first seed that products.json has since replaced (e.g. one "groceries"
# sub-category before grocery was split into aisles); these are overwritten, real seller edits are not
LEGACY_VALUES = {"subCategory": {"groceries"}}
# Main images that were 300 px catalog thumbnails; swapped for the full-size photo (sellers never upload these)
LEGACY_IMAGE_MARK = "cdn.dummyjson.com/product-images/"


async def seller_ids_by_category(pool) -> dict[str, int]:
    rows = await pool.fetch("SELECT id, email FROM users WHERE email = ANY($1::text[])", [s["email"] for s in SELLERS])
    by_email = {r["email"]: r["id"] for r in rows}
    return {c: by_email[s["email"]] for s in SELLERS if s["email"] in by_email for c in s["categories"]}


async def main() -> None:
    pool = await connect_postgres(run_schema=False)
    db = await connect_mongo()
    try:
        sellers = await seller_ids_by_category(pool)
        catalog = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
        fields = dict.fromkeys([*NEW_FIELDS, *LEGACY_VALUES, "image"], 1)
        existing = {p["name"]: p async for p in db.products.find({}, {"name": 1, **fields})}
        now = datetime.now(UTC)
        inserted = updated = 0
        for item in catalog:
            current = existing.get(item["name"])
            if current is None:
                if item["category"] not in sellers:
                    print(f"Skipped {item['name']!r}: no seller for {item['category']!r} (run scripts.seed first)")
                    continue
                doc = {**item, "sellerId": sellers[item["category"]], "active": True, "createdAt": now, "updatedAt": now}
                await db.products.insert_one(doc)
                inserted += 1
                continue
            missing = {f: item[f] for f in NEW_FIELDS if f in item and not current.get(f)}
            missing |= {f: item[f] for f, old in LEGACY_VALUES.items() if current.get(f) in old and item.get(f) not in old}
            image = current.get("image") or ""
            if LEGACY_IMAGE_MARK in image and "/thumbnail." in image and item["image"] != image:
                missing["image"] = item["image"]
            if missing:
                await db.products.update_one({"_id": current["_id"]}, {"$set": missing})
                updated += 1
        print(f"Catalog synced: {inserted} products added, {updated} updated, {len(catalog)} in products.json")
    finally:
        await close_mongo()
        await close_postgres()


if __name__ == "__main__":
    asyncio.run(main())
