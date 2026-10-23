"""AI listing writer: turns a seller's rough notes into a search-friendly product listing.

With an Anthropic API key, Claude writes the listing (structured JSON output). Without one, a
template writer produces a clean, reasonable listing so the feature still works in development.
"""

import re

from ..llm import client as llm

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Product title, 50-110 characters: brand + product type + key feature + size/variant"},
        "description": {"type": "string", "description": "2 short paragraphs, 80-160 words, plain text, no markdown"},
        "highlights": {"type": "array", "items": {"type": "string"}, "description": "4-6 key benefits, under 80 characters each"},
        "tags": {
            "type": "array",
            "items": {"type": "string"},
            "description": "6-10 lowercase search keywords shoppers in India would type",
        },
        "metaDescription": {
            "type": "string",
            "description": "Search-result snippet, 140-160 characters, mentions price benefit or delivery",
        },
    },
    "required": ["title", "description", "highlights", "tags", "metaDescription"],
    "additionalProperties": False,
}

SYSTEM = (
    "You write product listings for Arvixa, an Indian online marketplace. Write in clear Indian English for shoppers "
    "comparing products on their phone. Use only facts the seller gave you: never invent certifications, materials, "
    "warranty terms, dimensions or claims like 'best' or '#1'. If a detail is missing, leave it out rather than guess. "
    "Prices are in rupees. Keep titles keyword-rich but readable, the way top sellers on large Indian marketplaces do."
)


def _prompt(p: dict) -> str:
    fields = [
        ("Product name", p.get("name")),
        ("Brand", p.get("brand")),
        ("Category", p.get("category")),
        ("Who it's for", p.get("audience")),
        ("Pack size / variant", p.get("unit")),
        ("Price (INR)", p.get("price")),
        ("MRP (INR)", p.get("mrp")),
        ("Seller's notes / current description", p.get("description")),
        ("Existing tags", ", ".join(p.get("tags") or [])),
    ]
    known = "\n".join(f"- {label}: {value}" for label, value in fields if value not in (None, "", []))
    return f"Write the listing for this product.\n\n{known}"


def _template(p: dict) -> dict:
    """Deterministic fallback when no API key is configured."""
    name = re.sub(r"\s+", " ", str(p.get("name") or "Product")).strip()
    brand = str(p.get("brand") or "").strip()
    unit = str(p.get("unit") or "").strip()
    category = str(p.get("category") or "").replace("-", " ")
    title = " ".join(x for x in [brand if brand and brand.lower() not in name.lower() else "", name, f"({unit})" if unit else ""] if x)
    notes = str(p.get("description") or "").strip()
    who = {"women": "for women", "men": "for men", "unisex": "for everyone"}.get(str(p.get("audience") or ""), "")
    first = f"{title} {who}".strip() + (f" from our {category} range." if category else ".")
    description = f"{first} {notes}".strip() if notes else f"{first} Made for everyday use and easy to love."
    words = {
        w
        for w in re.findall(r"[a-z]{3,}", f"{name} {brand} {category} {notes}".lower())
        if w not in {"the", "and", "for", "with", "from", "this"}
    }
    tags = list(dict.fromkeys([*(t.lower() for t in p.get("tags") or []), *([brand.lower()] if brand else []), category, *sorted(words)]))[
        :10
    ]
    price = p.get("price")
    meta = f"Buy {title} online at Arvixa{f' for ₹{price}' if price else ''}. Free delivery over ₹499, UPI & COD, easy returns."
    return {
        "title": title[:110],
        "description": description[:900],
        "highlights": [
            h
            for h in [
                f"Brand: {brand}" if brand else "",
                f"Pack size: {unit}" if unit else "",
                "Free delivery on orders over ₹499",
                "Easy 7-day returns",
            ]
            if h
        ],
        "tags": [t for t in tags if t],
        "metaDescription": meta[:160],
    }


def generate(product: dict) -> dict:
    if not llm.enabled():
        return {**_template(product), "source": "template"}
    try:
        return {**llm.structured(SYSTEM, _prompt(product), SCHEMA), "source": "claude"}
    except llm.Declined:
        return {**_template(product), "source": "template"}
