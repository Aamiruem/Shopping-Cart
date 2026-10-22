"""SEO files for search engines: /sitemap.xml (every page and product) and /robots.txt.

nginx (production) and the Vite dev server forward these two root paths to the API.
"""

import re
from datetime import UTC, datetime
from xml.sax.saxutils import escape

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse, Response

from ..core.cache import cached
from ..core.config import get_settings
from ..db.mongo import get_db
from ..services.catalog import CATEGORIES, CATEGORY_GROUPS

router = APIRouter(tags=["seo"], include_in_schema=False)
PRIVATE = ["/cart", "/checkout", "/account", "/orders", "/wishlist", "/seller/", "/login", "/register", "/api/"]


def site_url() -> str:
    s = get_settings()
    return (s.site_url or (s.cors_origins[0] if s.cors_origins else "http://localhost:5173")).rstrip("/")


def slugify(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[\s_]+", "-", re.sub(r"[^\w\s-]", "", text.lower()).strip()))[:80]


async def _sitemap() -> str:
    base = site_url()
    today = datetime.now(UTC).date().isoformat()
    urls = [
        (f"{base}/", "daily", "1.0", today),
        (f"{base}/products", "daily", "0.9", today),
        (f"{base}/grocery", "daily", "0.9", today),
        (f"{base}/sell", "monthly", "0.5", today),
        (f"{base}/help", "monthly", "0.4", today),
    ]
    urls += [(f"{base}/products?category={c}", "daily", "0.8", today) for c in CATEGORIES]
    urls += [(f"{base}/products?use={g}", "weekly", "0.7", today) for g in CATEGORY_GROUPS]
    urls += [(f"{base}/products?category=fashion&audience={a}", "daily", "0.8", today) for a in ("women", "men")]
    async for p in get_db().products.find({"active": {"$ne": False}}, {"name": 1, "updatedAt": 1}):
        updated = p.get("updatedAt")
        lastmod = updated.date().isoformat() if isinstance(updated, datetime) else today
        urls.append((f"{base}/products/{p['_id']}/{slugify(p['name'])}", "weekly", "0.6", lastmod))
    body = "".join(
        f"<url><loc>{escape(loc)}</loc><lastmod>{mod}</lastmod><changefreq>{freq}</changefreq><priority>{prio}</priority></url>"
        for loc, freq, prio, mod in urls
    )
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{body}</urlset>'


@router.get("/sitemap.xml")
async def sitemap():
    return Response(await cached("catalog:sitemap", 600, _sitemap), media_type="application/xml")


@router.get("/robots.txt")
async def robots():
    lines = [
        "User-agent: *",
        "Allow: /",
        *[f"Disallow: {p}" for p in PRIVATE],
        "Disallow: /*?*sort=",
        "",
        f"Sitemap: {site_url()}/sitemap.xml",
    ]
    return PlainTextResponse("\n".join(lines) + "\n")
