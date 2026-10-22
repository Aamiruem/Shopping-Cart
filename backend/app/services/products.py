"""Product create / update / delete with ownership rules.

Sellers manage only their own products; admins manage everything.
"""

from datetime import UTC, datetime

from ..core.cache import invalidate
from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser
from ..schemas.product import ProductIn, ProductPatch
from .catalog import serialize_product, to_object_id


async def get_owned(product_id: str, actor: CurrentUser) -> dict:
    oid = to_object_id(product_id)
    product = await get_db().products.find_one({"_id": oid}) if oid else None
    if not product:
        raise ApiError(404, "Product not found")
    if not actor.is_admin and product.get("sellerId") != actor.id:
        raise ApiError(403, "You can only manage your own products")
    return product


async def create(data: ProductIn, actor: CurrentUser) -> dict:
    invalidate("catalog:")
    now = datetime.now(UTC)
    doc = data.model_dump()
    if not actor.is_admin:
        doc["featured"] = False
    doc.update(
        sellerId=actor.id,
        rating=0.0,
        ratingCount=0,
        images=doc["images"] or ([doc["image"]] if doc["image"] else []),
        createdAt=now,
        updatedAt=now,
    )
    result = await get_db().products.insert_one(doc)
    doc["_id"] = result.inserted_id
    return serialize_product(doc)


async def update(product_id: str, data: ProductIn, actor: CurrentUser) -> dict:
    invalidate("catalog:")
    product = await get_owned(product_id, actor)
    changes = data.model_dump()
    if not actor.is_admin:
        changes["featured"] = product.get("featured", False)
    changes["images"] = changes["images"] or ([changes["image"]] if changes["image"] else [])
    changes["updatedAt"] = datetime.now(UTC)
    await get_db().products.update_one({"_id": product["_id"]}, {"$set": changes})
    return serialize_product({**product, **changes})


async def patch(product_id: str, data: ProductPatch, actor: CurrentUser) -> dict:
    invalidate("catalog:")
    product = await get_owned(product_id, actor)
    changes = data.model_dump(exclude_none=True)
    price, mrp = changes.get("price", product["price"]), changes.get("mrp", product.get("mrp"))
    if mrp is not None and mrp < price:
        raise ApiError(400, "MRP cannot be lower than the selling price")
    changes["updatedAt"] = datetime.now(UTC)
    await get_db().products.update_one({"_id": product["_id"]}, {"$set": changes})
    return serialize_product({**product, **changes})


async def delete(product_id: str, actor: CurrentUser) -> None:
    invalidate("catalog:")
    product = await get_owned(product_id, actor)
    db = get_db()
    await db.products.delete_one({"_id": product["_id"]})
    # Remove it from carts and wishlists so shoppers don't see a dead item
    await db.carts.update_many({}, {"$pull": {"items": {"product": product["_id"]}}})
    await db.wishlists.update_many({}, {"$pull": {"products": product["_id"]}})
