"""Product documents: id handling and the JSON shape the frontend and AI service expect."""

from datetime import datetime

from bson import ObjectId
from bson.errors import InvalidId

CATEGORIES = ["mobiles", "electronics", "fashion", "accessories", "beauty", "home", "kitchen", "sports", "grocery"]


def to_object_id(value) -> ObjectId | None:
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def discount_percent(price: float, mrp: float | None) -> int:
    if not mrp or mrp <= price:
        return 0
    return round((mrp - price) / mrp * 100)


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else value


def serialize_product(doc: dict) -> dict:
    """Mongo document -> API JSON (same fields the old Mongoose model returned, plus seller info)."""
    out = {k: v for k, v in doc.items() if k not in ("_id", "__v")}
    out["_id"] = str(doc["_id"])
    out["id"] = out["_id"]
    out["discount"] = discount_percent(doc.get("price", 0), doc.get("mrp"))
    out["active"] = doc.get("active", True)
    for key in ("createdAt", "updatedAt"):
        if key in out:
            out[key] = _iso(out[key])
    return out
