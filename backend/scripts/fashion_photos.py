"""Replace the fashion catalog's Wikimedia snapshots with on-model studio photos from Pexels.

Each product still on a /catalog/ Wikimedia image gets a portrait photo (800x1200, WebP) found by a
garment-specific search ("indian woman wearing saree", "man wearing puffer jacket", ...). Photos are
saved under frontend/public/catalog, credited in `imageCredit`, written to app/data/products.json and
applied to the database (only where the product still shows the old picture, so seller edits stay).

    PEXELS_API_KEY=... python -m scripts.fashion_photos --dry-run   # show the picks, change nothing
    PEXELS_API_KEY=... python -m scripts.fashion_photos

Free key: https://www.pexels.com/api/ (200 requests/hour; this needs about 35). Pexels License:
free for commercial use, no attribution required (we keep the credit anyway).
"""

import argparse
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path

import httpx
from PIL import Image

from app.db.mongo import close_mongo, connect_mongo
from scripts.seed import PRODUCTS_FILE

CATALOG_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public" / "catalog"
SEARCH_URL = "https://api.pexels.com/v1/search"
SIZE = (800, 1200)  # 2:3 portrait, shown at 3:4 on cards with a top-anchored crop

# (word in the product name, audience or None for any, Pexels query) - first match wins
QUERIES = [
    ("Formal Shoes", None, "men leather formal shoes"),
    ("Cargo Shorts", None, "man wearing cargo shorts"),
    ("Joggers", None, "man wearing joggers streetwear"),
    ("Track Pants", None, "man wearing track pants"),
    ("Nehru Jacket", None, "indian man nehru jacket"),
    ("Kurta", "men", "indian man wearing kurta"),
    ("Jeans", "men", "man wearing jeans fashion"),
    ("Formal Shirt", None, "man wearing formal shirt"),
    ("Polo", None, "man wearing polo shirt"),
    ("T-Shirt", None, "man wearing plain t-shirt"),
    ("Hoodie", None, "man wearing hoodie"),
    ("Sweater", None, "man wearing knit sweater"),
    ("Puffer", None, "man wearing puffer jacket"),
    ("Thermal", None, "thermal base layer clothing"),
    ("Rain Jacket", None, "person wearing rain jacket"),
    ("Sneakers", None, "casual sneakers"),
    ("Running Shoes", None, "running shoes"),
    ("Home Slippers", None, "house slippers"),
    ("Ankle Boots", None, "ankle boots"),
    ("Flip-Flop", None, "flip flops"),
    ("Sandals", None, "sandals footwear"),
    ("Heels", None, "high heels shoes"),
    ("Jeans", "women", "woman wearing jeans fashion"),
    ("Leggings", None, "woman wearing leggings"),
    ("Dress", None, "woman wearing summer dress"),
    ("Anarkali", None, "indian woman anarkali dress"),
    ("Dupatta", None, "indian woman wearing dupatta"),
    ("Kurti", None, "indian woman wearing kurti"),
    ("Lehenga", None, "woman wearing lehenga"),
    ("Salwar", None, "indian woman salwar kameez"),
    ("Saree", None, "woman wearing saree"),
    ("Cardigan", None, "woman wearing cardigan"),
    ("Shawl", None, "woman wearing shawl"),
]


def query_for(product: dict) -> str | None:
    for word, audience, query in QUERIES:
        if word.lower() in product["name"].lower() and audience in (None, product.get("audience")):
            return query
    return None


def write_catalog(products: list[dict]) -> None:
    """Same layout as the hand-maintained file: one compact product per line."""
    lines = ",\n".join("  " + json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in products)
    PRODUCTS_FILE.write_text(f"[\n{lines}\n]\n", encoding="utf-8")


def to_webp(raw: bytes) -> bytes:
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    # cover-crop to 2:3, keeping the top (faces, necklines) rather than the centre
    ratio = SIZE[0] / SIZE[1]
    w, h = img.size
    if w / h > ratio:
        nw = round(h * ratio)
        img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        img = img.crop((0, 0, w, round(w / ratio)))
    img = img.resize(SIZE, Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "WEBP", quality=84, method=6)
    return out.getvalue()


async def main(dry_run: bool) -> None:
    env_file = Path(__file__).resolve().parents[1] / ".env"
    env = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line and not line.startswith("#")) if env_file.exists() else {}
    key = os.getenv("PEXELS_API_KEY") or env.get("PEXELS_API_KEY", "").strip().strip('"')
    if not key:
        raise SystemExit("Set PEXELS_API_KEY (free at https://www.pexels.com/api/)")
    products = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    targets = [p for p in products if p["category"] == "fashion" and p["image"].startswith("/catalog/") and query_for(p)]
    print(f"{len(targets)} fashion products to re-photograph")

    pool: dict[str, list[dict]] = {}  # query -> unused Pexels photos
    used: set[int] = set()
    changes: dict[str, tuple[str, dict]] = {}  # product name -> (old image, new fields)
    async with httpx.AsyncClient(timeout=30, headers={"Authorization": key}) as http:
        for product in targets:
            query = query_for(product)
            if query not in pool:
                r = await http.get(SEARCH_URL, params={"query": query, "orientation": "portrait", "per_page": 40})
                r.raise_for_status()
                pool[query] = [ph for ph in r.json()["photos"] if ph["height"] >= 1200]
            photo = next((ph for ph in pool[query] if ph["id"] not in used), None)
            if not photo:
                print(f"  no unused photo left for {product['name']!r} ({query})")
                continue
            used.add(photo["id"])
            credit = {"author": photo["photographer"], "license": "Pexels License", "source": photo["url"]}
            print(f"  {product['name']:<50} <- {photo['url']}")
            if dry_run:
                continue
            raw = (await http.get(photo["src"]["large2x"])).content
            data = to_webp(raw)
            path = f"/catalog/{hashlib.sha1(data).hexdigest()[:16]}.webp"
            (CATALOG_DIR / path.rsplit("/", 1)[1]).write_bytes(data)
            fields = {"image": path, "images": [path], "imageCredit": credit}
            changes[product["name"]] = (product["image"], fields)
            product.update(fields)

    if dry_run or not changes:
        return
    write_catalog(products)

    # Old snapshots nobody uses any more
    still_used = {src for p in products for src in [p["image"], *p.get("images", []), *p.get("images360", [])]}
    for old, _ in changes.values():
        if old not in still_used:
            (CATALOG_DIR / old.rsplit("/", 1)[1]).unlink(missing_ok=True)

    db = await connect_mongo()
    try:
        updated = 0
        for name, (old, fields) in changes.items():
            res = await db.products.update_one({"name": name, "image": old}, {"$set": fields})
            updated += res.modified_count
        print(f"Saved {len(changes)} photos; {updated} products updated in the database")
    finally:
        await close_mongo()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print the chosen photos without saving anything")
    asyncio.run(main(parser.parse_args().dry_run))
