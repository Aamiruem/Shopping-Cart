"""SEO for search engines and link previews: /sitemap.xml, /robots.txt and server-rendered page heads.

nginx (production) and the Vite dev server forward /sitemap.xml and /robots.txt to the API. In production
nginx also sends product and category pages to /api/seo/page, which returns the storefront's index.html with
that page's title, description, canonical link, Open Graph / Twitter card, schema.org data and a plain-HTML copy
of the content already in it. Google runs the JavaScript anyway; Bing and link previews (WhatsApp, Facebook,
X, LinkedIn) don't, and without this they would see the same generic page for every product.
"""

import html
import json
import re
from datetime import UTC, datetime
from urllib.parse import parse_qs, quote, urlsplit
from xml.sax.saxutils import escape

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, Response

from ..core.cache import cached
from ..core.config import get_settings
from ..core.errors import ApiError
from ..db.mongo import get_db
from ..services.catalog import CATEGORIES, CATEGORY_GROUPS, discount_percent, to_object_id

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


# ---------- Server-rendered page heads (/api/seo/page) ----------

SITE = "Arvixa"
CATEGORY_LABELS = {
    "mobiles": "Mobiles",
    "electronics": "Electronics",
    "fashion": "Fashion",
    "accessories": "Watches & Bags",
    "beauty": "Beauty",
    "home": "Home & Furniture",
    "kitchen": "Kitchen",
    "sports": "Sports",
    "grocery": "Grocery",
}
GROUP_LABELS = {"daily": "Daily Use", "general": "General Use"}
AUDIENCE_HEADINGS = {"women": "Women's Fashion", "men": "Men's Fashion"}
FILTER_PARAMS = ("brand", "minPrice", "maxPrice", "minRating")  # filtered variants are noindex, as in the SPA


async def _index_template() -> str:
    url = get_settings().frontend_index_url

    async def fetch() -> str:
        if not url:
            raise ApiError(503, "FRONTEND_INDEX_URL is not set")
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(url)
            r.raise_for_status()
            return r.text

    # Short cache: after a storefront deploy the old index.html points at build files that no longer exist
    return await cached("seo:index-html", 10, fetch)


def _abs(url: str) -> str:
    return url if url.startswith(("http://", "https://")) else f"{site_url()}{url if url.startswith('/') else '/' + url}"


def _esc(value) -> str:
    return html.escape(str(value), quote=True)


def _price(value) -> str:
    return f"₹{round(float(value or 0)):,}"


def _ld(item: dict) -> str:
    # < for every "<": text such as a search for "</script>" can never end or confuse the script block
    data = json.dumps({"@context": "https://schema.org", **item}, ensure_ascii=False).replace("<", "\\u003c")
    return f'<script type="application/ld+json" data-seo="1">{data}</script>'


def _breadcrumb(items: list[tuple[str, str]]) -> dict:
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": i, "name": n, "item": _abs(p)} for i, (n, p) in enumerate(items, 1)],
    }


def _head(title, description, path, image="", og_type="website", noindex=False, extra="", json_ld=()) -> str:
    """The same tags (and attribute names) useSeo() sets in the browser, so the SPA updates rather than duplicates them."""
    full = f"{title} | {SITE}"
    url, img = _abs(path), _abs(image or "/brand/arvixa-logo.webp")
    robots = "noindex, nofollow" if noindex else "index, follow, max-image-preview:large"
    tags = [
        f"<title>{_esc(full)}</title>",
        f'<meta name="description" content="{_esc(description)}" />',
        f'<meta name="robots" content="{robots}" />',
        f'<link rel="canonical" href="{_esc(url)}" />',
        f'<meta property="og:site_name" content="{SITE}" />',
        f'<meta property="og:type" content="{og_type}" />',
        f'<meta property="og:title" content="{_esc(full)}" />',
        f'<meta property="og:description" content="{_esc(description)}" />',
        f'<meta property="og:url" content="{_esc(url)}" />',
        f'<meta property="og:image" content="{_esc(img)}" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        f'<meta name="twitter:title" content="{_esc(full)}" />',
        f'<meta name="twitter:description" content="{_esc(description)}" />',
        f'<meta name="twitter:image" content="{_esc(img)}" />',
        extra,
        *[_ld(item) for item in json_ld],
    ]
    return "\n    ".join(t for t in tags if t)


def _render(template: str, head: str, body: str) -> str:
    page = re.sub(r"<title>.*?</title>\s*", "", template, flags=re.S)
    # Drop index.html's generic description, preview card and comment; the page's own versions go in below
    page = re.sub(r'<meta (?:name="(?:description|robots|twitter:[\w:]+)"|property="og:[\w:]+")[^>]*>\s*', "", page)
    page = re.sub(r'<link rel="canonical"[^>]*>\s*|<!-- Link-preview defaults.*?-->\s*', "", page, flags=re.S)
    page = page.replace("</head>", f"    {head}\n  </head>", 1)
    # Plain HTML for crawlers that don't run JavaScript; React replaces it on load
    return page.replace('<div id="root"></div>', f'<div id="root">{body}</div>', 1)


async def _product_page(product_id: str) -> tuple[int, str, str]:
    oid = to_object_id(product_id)
    p = await get_db().products.find_one({"_id": oid, "active": {"$ne": False}}) if oid else None
    if not p:
        return 404, _head("Product not found", "This product is no longer available on Arvixa.", "/products", noindex=True), ""
    name, brand, price = p["name"], p.get("brand") or SITE, p.get("price", 0)
    off = discount_percent(price, p.get("mrp"))
    category = CATEGORY_LABELS.get(p.get("category", ""), p.get("category", ""))
    path = f"/products/{p['_id']}/{slugify(name)}"
    images = [_abs(i) for i in (p.get("images") or [p.get("image")]) if i]
    unit = f" ({p['unit']})" if p.get("unit") else ""
    rupees = f"₹{round(float(price or 0))}"  # written exactly like ProductDetail's useSeo, so the title never changes on load
    title = f"{name}{unit} - Buy online at {rupees}"
    saving = f" ({off}% off)" if off else ""
    summary = (p.get("description") or "")[:110]
    description = f"{name} by {brand} at {rupees}{saving}. {summary} Free delivery over ₹499, easy returns."
    offer = {
        "@type": "Offer",
        "url": _abs(path),
        "priceCurrency": "INR",
        "price": f"{float(price):.2f}",
        "availability": "https://schema.org/InStock" if p.get("stock", 0) > 0 else "https://schema.org/OutOfStock",
        "itemCondition": "https://schema.org/NewCondition",
    }
    product_ld = {
        "@type": "Product",
        "name": name,
        "description": p.get("description", ""),
        "image": images,
        "sku": str(p["_id"]),
        "category": p.get("category"),
        "offers": offer,
    }
    if p.get("brand"):
        product_ld["brand"] = {"@type": "Brand", "name": p["brand"]}
    if p.get("rating") and p.get("ratingCount"):
        product_ld["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": p["rating"],
            "reviewCount": p["ratingCount"],
            "bestRating": 5,
        }
    category_path = f"/products?category={p.get('category')}"
    crumbs = [("Home", "/"), (category, category_path), (name, path)]
    price_tags = "\n    ".join(
        [
            f'<meta property="product:price:amount" content="{float(price):.2f}" />',
            '<meta property="product:price:currency" content="INR" />',
        ]
    )
    head = _head(title, description, path, p.get("image", ""), "product", extra=price_tags, json_ld=(product_ld, _breadcrumb(crumbs)))
    picture = f'<img src="{_esc(images[0])}" alt="{_esc(name)}" width="400" height="400" />' if images else ""
    body = (
        f'<nav aria-label="Breadcrumb"><a href="/">Home</a> › <a href="{_esc(category_path)}">{_esc(category)}</a></nav>'
        f"<h1>{_esc(name)}</h1>{picture}"
        f"<p>{_esc(brand)} · {_price(price)}{saving}</p>"
        f"<p>{_esc(p.get('description') or '')}</p>"
    )
    return 200, head, body


async def _listing_page(query: dict[str, str]) -> tuple[int, str, str]:
    category, audience, group, q = (query.get(k, "") for k in ("category", "audience", "use", "q"))
    fashion_audience = category == "fashion" and audience in AUDIENCE_HEADINGS
    if q:
        heading, title, path = f"Results for “{q}”", f"{q} - Buy online at best price", f"/products?q={quote(q)}"
    else:
        heading = (
            AUDIENCE_HEADINGS[audience] if fashion_audience else CATEGORY_LABELS.get(category) or GROUP_LABELS.get(group) or "All Products"
        )
        title = f"{heading} - Buy {heading} online at best prices"
        if category in CATEGORY_LABELS:
            path = f"/products?category={category}" + (f"&audience={audience}" if fashion_audience else "")
        else:
            path = f"/products?use={group}" if group in GROUP_LABELS else "/products"

    find: dict = {"active": {"$ne": False}}
    if category in CATEGORY_LABELS:
        find["category"] = category
        if fashion_audience:
            find["audience"] = {"$in": [audience, "unisex"]}
    elif group in GROUP_LABELS:
        find["category"] = {"$in": CATEGORY_GROUPS[group]}
    cursor = get_db().products.find(find, {"name": 1, "price": 1}).sort("ratingCount", -1).limit(30)
    products = [] if q else [d async for d in cursor]

    label = heading.replace("“", "").replace("”", "")
    count = len(products) or "Hundreds of"
    description = (
        f"Shop {label} online at Arvixa. {count} products with top brands, great discounts, free delivery over ₹499 and easy returns."
    )
    links = [(p["name"], f"/products/{p['_id']}/{slugify(p['name'])}", p.get("price", 0)) for p in products]
    json_ld = [_breadcrumb([("Home", "/"), (label, path)])]
    if links:
        items = [{"@type": "ListItem", "position": i, "url": _abs(u), "name": n} for i, (n, u, _) in enumerate(links, 1)]
        json_ld.append({"@type": "ItemList", "itemListElement": items})
    noindex = any(query.get(k) for k in FILTER_PARAMS)
    head = _head(title, description, path, noindex=noindex, json_ld=json_ld)
    items_html = "".join(f'<li><a href="{_esc(u)}">{_esc(n)}</a> {_price(pr)}</li>' for n, u, pr in links)
    body = f"<h1>{_esc(heading)}</h1>" + (f"<ul>{items_html}</ul>" if links else "")
    return 200, head, body


@router.get("/api/seo/page")
async def seo_page(request: Request):
    """index.html for the URL in X-Original-URI (set by nginx), with that page's SEO tags and content filled in."""
    template = await _index_template()
    parts = urlsplit(request.headers.get("x-original-uri") or "/")
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    if m := re.fullmatch(r"/products/([^/]+)(?:/[^/]*)?", parts.path):
        status, head, body = await _product_page(m[1])
    elif parts.path in ("/products", "/products/"):
        status, head, body = await _listing_page(query)
    else:
        return HTMLResponse(template)
    headers = {"Cache-Control": "no-cache"}  # like index.html: always pick up the latest build
    return HTMLResponse(_render(template, head, body), status_code=status, headers=headers)
