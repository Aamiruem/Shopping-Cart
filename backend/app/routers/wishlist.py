"""/api/wishlist - saved products (MongoDB)."""

from fastapi import APIRouter, Depends

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser, get_current_user
from ..services.catalog import serialize_product, to_object_id

router = APIRouter(prefix="/api/wishlist", tags=["wishlist"])


async def _products(user_id: int) -> list[dict]:
    db = get_db()
    wishlist = await db.wishlists.find_one({"userId": user_id}) or {"products": []}
    ids = wishlist["products"]
    found = {p["_id"]: p async for p in db.products.find({"_id": {"$in": ids}, "active": {"$ne": False}})}
    return [serialize_product(found[i]) for i in ids if i in found]  # keep the order items were saved in


@router.get("")
async def get_wishlist(user: CurrentUser = Depends(get_current_user)):
    return await _products(user.id)


@router.post("/{product_id}", status_code=201)
async def add(product_id: str, user: CurrentUser = Depends(get_current_user)):
    oid = to_object_id(product_id)
    if not oid or not await get_db().products.find_one({"_id": oid}, {"_id": 1}):
        raise ApiError(404, "Product not found")
    await get_db().wishlists.update_one({"userId": user.id}, {"$addToSet": {"products": oid}}, upsert=True)
    return await _products(user.id)


@router.delete("/{product_id}")
async def remove(product_id: str, user: CurrentUser = Depends(get_current_user)):
    if oid := to_object_id(product_id):
        await get_db().wishlists.update_one({"userId": user.id}, {"$pull": {"products": oid}})
    return await _products(user.id)
