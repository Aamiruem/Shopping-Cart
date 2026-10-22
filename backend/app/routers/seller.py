"""/api/seller - seller onboarding, product CRUD, image upload and the seller's orders."""

import re

from fastapi import APIRouter, Depends, File, Response, UploadFile
from pydantic import BaseModel

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user, require_seller
from ..schemas.product import ProductIn, ProductPatch
from ..services import products as product_service
from ..services.catalog import serialize_product
from ..services.storage import MAX_BYTES, save_product_image
from ..services.validation import phone_error
from .auth import session

router = APIRouter(prefix="/api/seller", tags=["seller"])

GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")


class SellerIn(BaseModel):
    storeName: str = ""
    gstin: str | None = None
    phone: str | None = None


@router.post("/register")
async def register_seller(body: SellerIn, user: CurrentUser = Depends(get_current_user)):
    """Turns the logged-in customer into a seller. Returns a fresh session (the role changed)."""
    store = body.storeName.strip()
    gstin = (body.gstin or "").strip().upper() or None
    phone = (body.phone or "").strip() or None
    if not 3 <= len(store) <= 120:
        raise ApiError(400, "Store name must be 3–120 characters")
    if gstin and not GSTIN_RE.match(gstin):
        raise ApiError(400, "Please enter a valid 15-character GSTIN, e.g. 29ABCDE1234F1Z5")
    if error := phone_error(phone):
        raise ApiError(400, error)

    pool = get_pool()
    if await pool.fetchval("SELECT 1 FROM sellers WHERE user_id = $1", user.id):
        raise ApiError(409, "You are already registered as a seller")
    if await pool.fetchval("SELECT 1 FROM sellers WHERE lower(store_name) = lower($1)", store):
        raise ApiError(409, "That store name is taken. Please choose another.")

    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("INSERT INTO sellers (user_id, store_name, gstin, phone) VALUES ($1, $2, $3, $4)", user.id, store, gstin, phone)
        u = await conn.fetchrow(
            "UPDATE users SET role = CASE WHEN role = 'admin' THEN role ELSE 'seller' END WHERE id = $1 RETURNING *", user.id
        )
    return await session(dict(u))


@router.get("/profile")
async def profile(user: CurrentUser = Depends(require_seller)):
    record = await get_pool().fetchrow("SELECT * FROM sellers WHERE user_id = $1", user.id)
    return dict(record) if record else {"user_id": user.id, "store_name": "Arvixa (admin)", "gstin": None}


# ---------- Products (CRUD) ----------


@router.get("/products")
async def my_products(q: str | None = None, status: str | None = None, user: CurrentUser = Depends(require_seller)):
    """The seller's own products, including unlisted ones. Admins see every product."""
    query: dict = {} if user.is_admin else {"sellerId": user.id}
    if q and q.strip():
        pattern = re.compile(re.escape(q.strip()), re.I)
        query["$or"] = [{"name": pattern}, {"brand": pattern}, {"category": pattern}]
    if status == "active":
        query["active"] = {"$ne": False}
    elif status == "inactive":
        query["active"] = False
    elif status == "low_stock":
        query["stock"] = {"$lt": 10}
    cursor = get_db().products.find(query).sort([("updatedAt", -1), ("_id", -1)]).limit(500)
    return [serialize_product(p) async for p in cursor]


@router.get("/products/{product_id}")
async def my_product(product_id: str, user: CurrentUser = Depends(require_seller)):
    return serialize_product(await product_service.get_owned(product_id, user))


@router.post("/products", status_code=201)
async def create_product(body: ProductIn, user: CurrentUser = Depends(require_seller)):
    return await product_service.create(body, user)


@router.put("/products/{product_id}")
async def update_product(product_id: str, body: ProductIn, user: CurrentUser = Depends(require_seller)):
    return await product_service.update(product_id, body, user)


@router.patch("/products/{product_id}")
async def patch_product(product_id: str, body: ProductPatch, user: CurrentUser = Depends(require_seller)):
    return await product_service.patch(product_id, body, user)


@router.delete("/products/{product_id}", status_code=204)
async def delete_product(product_id: str, user: CurrentUser = Depends(require_seller)):
    await product_service.delete(product_id, user)
    return Response(status_code=204)


@router.post("/uploads", status_code=201)
async def upload_image(file: UploadFile = File(...), user: CurrentUser = Depends(require_seller)):
    """Uploads a product image (JPEG / PNG / WebP, max 5 MB) to S3 or local storage."""
    content = await file.read(MAX_BYTES + 1)
    return {"url": await save_product_image(content, file.content_type or "", user.id)}


# ---------- Orders containing the seller's products ----------


@router.get("/orders")
async def my_orders(status: str | None = None, limit: int = 100, user: CurrentUser = Depends(require_seller)):
    params: list = [] if user.is_admin else [user.id]
    where = [] if user.is_admin else ["oi.seller_id = $1"]
    if status in ("placed", "cancelled"):
        params.append(status)
        where.append(f"o.status = ${len(params)}")
    params.append(max(1, min(limit, 500)))
    sql = f"""
        SELECT o.id, o.created_at, o.status, o.payment_method, split_part(o.address, ',', 1) AS customer,
               json_agg(json_build_object('productId', oi.product_id, 'name', oi.name, 'image', oi.image,
                                          'price', oi.price, 'qty', oi.qty) ORDER BY oi.id) AS items,
               SUM(oi.price * oi.qty) AS amount
          FROM order_items oi JOIN orders o ON o.id = oi.order_id
         {'WHERE ' + ' AND '.join(where) if where else ''}
         GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${len(params)}"""
    return rows(await get_pool().fetch(sql, *params))
