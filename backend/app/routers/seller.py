"""/api/seller - onboarding, store profile & payout details, product CRUD (+ bulk actions), media uploads,
order fulfilment and earnings."""

import asyncio
import re
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import BaseModel, Field

from ..core.cache import invalidate
from ..core.errors import ApiError
from ..core.security import verify_password
from ..db.mongo import get_db
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user, require_seller
from ..schemas.product import ProductIn, ProductPatch
from ..services import products as product_service
from ..services.catalog import serialize_product
from ..services.crypto import decrypt, encrypt
from ..services.orders import FULFILMENT_STEPS
from ..services.storage import MEDIA, save_media
from ..services.validation import phone_error
from ..services.verification import check_code, send_code
from .auth import session

router = APIRouter(prefix="/api/seller", tags=["seller"])

GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
UPI_RE = re.compile(r"^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$")  # e.g. store@okicici
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")  # RBI bank branch code, e.g. HDFC0001234
ACCOUNT_RE = re.compile(r"^\d{9,18}$")


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


def _mask(last4: str | None) -> str | None:
    return f"{'•' * 4}{last4}" if last4 else None


def _last4(record) -> str | None:
    if record["bank_account_last4"]:
        return record["bank_account_last4"]
    number = decrypt(record["bank_account_number"])  # rows saved before encryption
    return number[-4:] if number else None


def _public_profile(record) -> dict:
    """Store profile for the Seller Hub; the bank account number is encrypted and never leaves the server."""
    data = dict(record)
    data["bank_account_number"] = _mask(_last4(record))
    data.pop("bank_account_last4", None)
    return data


@router.get("/profile")
async def profile(user: CurrentUser = Depends(require_seller)):
    record = await get_pool().fetchrow("SELECT * FROM sellers WHERE user_id = $1", user.id)
    return _public_profile(record) if record else {"user_id": user.id, "store_name": "Arvixa (admin)", "gstin": None}


class ProfileIn(BaseModel):
    storeName: str = Field(min_length=3, max_length=120)
    description: str = Field(default="", max_length=1000)
    logo: str = Field(default="", max_length=1000)
    gstin: str | None = None
    phone: str | None = None
    payoutUpi: str | None = None
    bankAccountName: str | None = Field(default=None, max_length=120)
    bankAccountNumber: str | None = None  # omit (or send the masked value) to keep the saved one
    bankIfsc: str | None = None
    # Changing payout details needs the account password, or (Google-only accounts) an emailed code
    currentPassword: str | None = None
    otp: str | None = None


@router.post("/profile/otp")
async def payout_otp(user: CurrentUser = Depends(require_seller)):
    """Emails a code that confirms a payout change (for accounts that sign in with Google only)."""
    return await send_code("payout", user.email, "email", user_id=user.id)


async def _confirm_payout_change(body: ProfileIn, user: CurrentUser) -> None:
    account = await get_pool().fetchrow("SELECT password_hash FROM users WHERE id = $1", user.id)
    if account and account["password_hash"]:
        if not body.currentPassword or not await asyncio.to_thread(verify_password, body.currentPassword, account["password_hash"]):
            raise ApiError(403, "Enter your account password to change payout details")
        return
    if not body.otp:
        raise ApiError(403, "Enter the code we emailed you to change payout details")
    await check_code("payout", user.email, body.otp)


@router.put("/profile")
async def update_profile(body: ProfileIn, user: CurrentUser = Depends(require_seller)):
    """Store details shown to shoppers, plus where the seller's payouts go (UPI ID or bank account)."""
    pool = get_pool()
    current = await pool.fetchrow("SELECT * FROM sellers WHERE user_id = $1", user.id)
    if not current:
        raise ApiError(404, "Create your store first")
    store = body.storeName.strip()
    gstin = (body.gstin or "").strip().upper() or None
    phone = (body.phone or "").strip() or None
    upi = (body.payoutUpi or "").strip() or None
    ifsc = (body.bankIfsc or "").strip().upper() or None
    saved_number = decrypt(current["bank_account_number"])
    number = (body.bankAccountNumber or "").replace(" ", "")
    number = saved_number if not number or "•" in number else number
    if gstin and not GSTIN_RE.match(gstin):
        raise ApiError(400, "Please enter a valid 15-character GSTIN, e.g. 29ABCDE1234F1Z5")
    if error := phone_error(phone):
        raise ApiError(400, error)
    if upi and not UPI_RE.match(upi):
        raise ApiError(400, "Please enter a valid UPI ID, e.g. yourstore@okhdfcbank")
    if number and not ACCOUNT_RE.match(number):
        raise ApiError(400, "Bank account number must be 9 to 18 digits")
    if ifsc and not IFSC_RE.match(ifsc):
        raise ApiError(400, "Please enter a valid 11-character IFSC code, e.g. HDFC0001234")
    if number and not ifsc:
        raise ApiError(400, "Add the IFSC code of your bank branch")
    if body.logo and not re.match(r"^(https?://\S+|/api/uploads/[\w.-]+|/catalog/[\w.-]+)$", body.logo):
        raise ApiError(400, "Logo must be an uploaded image or an https link")
    account_name = (body.bankAccountName or "").strip() or None
    payout_changed = (upi, account_name, number or None, ifsc) != (
        current["payout_upi"],
        current["bank_account_name"],
        saved_number,
        current["bank_ifsc"],
    )
    if payout_changed:
        await _confirm_payout_change(body, user)
    if store.lower() != current["store_name"].lower() and await pool.fetchval(
        "SELECT 1 FROM sellers WHERE lower(store_name) = lower($1) AND user_id <> $2", store, user.id
    ):
        raise ApiError(409, "That store name is taken. Please choose another.")
    record = await pool.fetchrow(
        """UPDATE sellers SET store_name = $2, description = $3, logo = $4, gstin = $5, phone = $6, payout_upi = $7,
                  bank_account_name = $8, bank_account_number = $9, bank_ifsc = $10, bank_account_last4 = $11,
                  updated_at = NOW()
            WHERE user_id = $1 RETURNING *""",
        user.id,
        store,
        body.description.strip() or None,
        body.logo or None,
        gstin,
        phone,
        upi,
        account_name,
        encrypt(number) if number else None,
        ifsc,
        number[-4:] if number else None,
    )
    return _public_profile(record)


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


class BulkIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)
    action: Literal["list", "unlist", "delete", "stock"]
    stock: int | None = Field(default=None, ge=0, le=1_000_000)


@router.post("/products/bulk")
async def bulk_products(body: BulkIn, user: CurrentUser = Depends(require_seller)):
    """List / unlist / delete / set stock for many products at once (only the seller's own)."""
    if body.action == "stock" and body.stock is None:
        raise ApiError(400, "Enter the new stock quantity")
    done = 0
    for product_id in dict.fromkeys(body.ids):
        if body.action == "delete":
            await product_service.delete(product_id, user)
        else:
            changes = {"stock": body.stock} if body.action == "stock" else {"active": body.action == "list"}
            await product_service.patch(product_id, ProductPatch(**changes), user)
        done += 1
    return {"updated": done, "action": body.action}


@router.post("/products/{product_id}/duplicate", status_code=201)
async def duplicate_product(product_id: str, user: CurrentUser = Depends(require_seller)):
    """Copies a product as an unlisted draft, e.g. to add another size or colour quickly."""
    original = await product_service.get_owned(product_id, user)
    now = datetime.now(UTC)
    copy = {k: v for k, v in original.items() if k not in ("_id", "rating", "ratingCount", "featured")}
    copy.update(
        name=f"{original['name']} (copy)"[:200], active=False, rating=0.0, ratingCount=0, featured=False, createdAt=now, updatedAt=now
    )
    if not user.is_admin:
        copy["sellerId"] = user.id
    result = await get_db().products.insert_one(copy)
    invalidate("catalog:")
    copy["_id"] = result.inserted_id
    return serialize_product(copy)


@router.post("/uploads", status_code=201)
async def upload_media(
    file: UploadFile = File(...),
    kind: Literal["image", "video", "audio"] = Query("image"),
    user: CurrentUser = Depends(require_seller),
):
    """Uploads product media to S3 (production) or local storage: photos up to 15 MB (optimised to WebP), audio 10 MB, videos 50 MB."""
    content = await file.read(MEDIA[kind]["max"] + 1)
    return {"url": await save_media(content, file.content_type or "", user.id, kind), "kind": kind}


# ---------- Orders containing the seller's products ----------


@router.get("/orders")
async def my_orders(
    status: str | None = None, fulfilment: str | None = None, limit: int = 100, user: CurrentUser = Depends(require_seller)
):
    params: list = [] if user.is_admin else [user.id]
    where = [] if user.is_admin else ["oi.seller_id = $1"]
    if status in ("placed", "cancelled"):
        params.append(status)
        where.append(f"o.status = ${len(params)}")
    if fulfilment in FULFILMENT_STEPS:
        params.append(fulfilment)
        where.append(f"oi.fulfilment = ${len(params)}")
    params.append(max(1, min(limit, 500)))
    sql = f"""
        SELECT o.id, o.created_at, o.status, o.payment_method, split_part(o.address, ',', 1) AS customer, o.address,
               json_agg(json_build_object('productId', oi.product_id, 'name', oi.name, 'image', oi.image,
                                          'price', oi.price, 'qty', oi.qty, 'fulfilment', oi.fulfilment,
                                          'options', oi.options) ORDER BY oi.id) AS items,
               SUM(oi.price * oi.qty) AS amount,
               MIN(array_position(ARRAY['pending','packed','shipped','delivered'], oi.fulfilment::text)) AS step,
               (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status
          FROM order_items oi JOIN orders o ON o.id = oi.order_id
         {'WHERE ' + ' AND '.join(where) if where else ''}
         GROUP BY o.id ORDER BY o.created_at DESC LIMIT ${len(params)}"""
    result = rows(await get_pool().fetch(sql, *params))
    for r in result:  # an order is as far along as its least-advanced line from this seller
        r["fulfilment"] = FULFILMENT_STEPS[(r.pop("step") or 1) - 1]
    return result


class FulfilmentIn(BaseModel):
    fulfilment: Literal["pending", "packed", "shipped", "delivered"]


@router.patch("/orders/{order_id}")
async def update_fulfilment(order_id: int, body: FulfilmentIn, user: CurrentUser = Depends(require_seller)):
    """Moves the seller's lines of an order forward: pending -> packed -> shipped -> delivered."""
    pool = get_pool()
    order = await pool.fetchrow("SELECT status FROM orders WHERE id = $1", order_id)
    if not order:
        raise ApiError(404, "Order not found")
    if order["status"] == "cancelled":
        raise ApiError(400, "This order was cancelled")
    owner = "" if user.is_admin else " AND seller_id = $3"
    args = [order_id, body.fulfilment] + ([] if user.is_admin else [user.id])
    updated = await pool.fetch(
        f"""UPDATE order_items
               SET fulfilment = $2::varchar,
                   fulfilled_at = CASE WHEN $2::varchar = 'delivered' THEN NOW() ELSE fulfilled_at END
             WHERE order_id = $1{owner} RETURNING id""",
        *args,
    )
    if not updated:
        raise ApiError(404, "This order has none of your products")
    return {"orderId": order_id, "fulfilment": body.fulfilment, "lines": len(updated)}


@router.get("/earnings")
async def earnings(user: CurrentUser = Depends(require_seller)):
    """Sales, how they were paid, and recent online payments for the seller's products."""
    pool = get_pool()
    owner = "TRUE" if user.is_admin else "oi.seller_id = $1"
    args = [] if user.is_admin else [user.id]
    totals = await pool.fetchrow(
        f"""SELECT COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed'), 0) AS gross,
                   COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND oi.fulfilment = 'delivered'), 0) AS delivered,
                   COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'placed' AND oi.fulfilment <> 'delivered'), 0) AS in_progress,
                   COALESCE(SUM(oi.price * oi.qty) FILTER (WHERE o.status = 'cancelled'), 0) AS cancelled,
                   COALESCE(SUM(oi.price * oi.qty)
                            FILTER (WHERE o.status = 'placed' AND o.created_at > NOW() - INTERVAL '30 days'), 0) AS last30,
                   COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'placed') AS orders
              FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE {owner}""",
        *args,
    )
    by_method = await pool.fetch(
        f"""SELECT o.payment_method AS method, SUM(oi.price * oi.qty) AS amount, COUNT(DISTINCT o.id) AS orders
              FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE {owner} AND o.status = 'placed' GROUP BY 1 ORDER BY 2 DESC""",
        *args,
    )
    recent = await pool.fetch(
        f"""SELECT p.id, p.order_id, p.method, p.status, p.provider_payment_id, p.created_at,
                   SUM(oi.price * oi.qty) AS amount
              FROM payments p JOIN order_items oi ON oi.order_id = p.order_id
             WHERE {owner} GROUP BY p.id ORDER BY p.created_at DESC LIMIT 25""",
        *args,
    )
    payout = await pool.fetchrow(
        "SELECT payout_upi, bank_account_number, bank_account_last4, bank_ifsc FROM sellers WHERE user_id = $1", user.id
    )
    return {
        "totals": dict(totals),
        "byMethod": rows(by_method),
        "recentPayments": rows(recent),
        "payout": {
            "upi": payout and payout["payout_upi"],
            "bank": payout and _last4(payout) and f"{_mask(_last4(payout))} · {payout['bank_ifsc']}",
        },
    }
