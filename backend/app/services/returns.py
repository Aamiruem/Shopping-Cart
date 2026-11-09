"""Returns and refunds: the same flow and tables as api/_returns.mjs.

requested -> approved (courier pickup) -> received (the refund goes out) ; or rejected ; or withdrawn by the shopper.
Paid online: the money goes back to the UPI app, bank account or card it came from (Razorpay). Cash on delivery: to
the UPI ID or bank account the shopper gives (account number encrypted); the admin makes the transfer and records its
UTR, and the account number is then wiped. A seller handles returns for orders holding only their products; anything
mixed, and every manual bank or UPI refund, is for the admin.
"""

import re
from datetime import UTC, datetime, timedelta

from ..core.errors import ApiError
from ..db.postgres import get_pool
from .crypto import decrypt, encrypt
from .orders import add_event, refund_order, return_stock

RETURN_WINDOW_DAYS = 7
RETURN_REASONS = {
    "damaged": "Damaged or defective",
    "wrong_item": "Wrong item delivered",
    "missing": "Missing parts or items",
    "not_as_described": "Not as described",
    "size_fit": "Size or fit issue",
    "quality": "Quality not as expected",
    "not_needed": "No longer needed",
    "other": "Other reason",
}
ACTIONS = ("approve", "reject", "receive", "refund")
UPI_RE = re.compile(r"^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$")
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
ACCOUNT_RE = re.compile(r"^\d{9,18}$")
UTR_RE = re.compile(r"^[A-Za-z0-9-]{6,30}$")
OPEN = "(r.status IN ('requested', 'approved') OR (r.status = 'received' AND r.refund IS DISTINCT FROM 'refunded'))"


def _rupees(n) -> str:
    return f"₹{float(n):,.2f}".replace(".00", "")


def _destination(r) -> str:
    if r["refund_to"] == "original":
        return "your original payment method"
    if r["refund_to"] == "upi":
        return f"your UPI ID {r['refund_upi']}"
    return f"your bank account ••••{r['refund_account_last4']}"


def return_json(r, admin: bool = False) -> dict | None:
    """A return as the shopper sees it, or with the full account number for the admin making a manual transfer."""
    if not r:
        return None
    bank = (
        {"name": r["refund_account_name"], "last4": r["refund_account_last4"], "ifsc": r["refund_ifsc"]}
        if r["refund_account_last4"]
        else None
    )
    if admin and bank and r["refund"] == "cod_manual" and r["refund_account_number"]:
        bank["number"] = decrypt(r["refund_account_number"])
    return {
        "id": r["id"],
        "order_id": r["order_id"],
        "status": r["status"],
        "reason": r["reason"],
        "reason_code": r["reason_code"],
        "amount": None if r["amount"] is None else float(r["amount"]),
        "refund": r["refund"],
        "refund_to": r["refund_to"],
        "refund_upi": r["refund_upi"],
        "refund_bank": bank,
        "refund_reference": r["refund_reference"],
        "note": r["note"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "resolved_at": r["resolved_at"],
        "refunded_at": r["refunded_at"],
    }


async def order_return(order_id: int) -> dict | None:
    """The order's return, unless the shopper withdrew it (they can then ask again)."""
    return return_json(await get_pool().fetchrow("SELECT * FROM order_returns WHERE order_id = $1 AND status <> 'withdrawn'", order_id))


def _refund_account(body: dict) -> dict:
    to = body.get("refundTo")
    if to == "upi":
        upi = (body.get("upi") or "").strip()
        if not UPI_RE.match(upi):
            raise ApiError(400, "Please enter a valid UPI ID, like name@okhdfcbank")
        return {"to": "upi", "upi": upi}
    if to == "bank":
        name = (body.get("accountName") or "").strip()
        number = re.sub(r"\s", "", body.get("accountNumber") or "")
        ifsc = (body.get("ifsc") or "").strip().upper()
        if not 2 <= len(name) <= 120:
            raise ApiError(400, "Please enter the account holder’s name")
        if not ACCOUNT_RE.match(number):
            raise ApiError(400, "Please enter a valid bank account number (9 to 18 digits)")
        if not IFSC_RE.match(ifsc):
            raise ApiError(400, "Please enter a valid IFSC code, like HDFC0001234")
        return {"to": "bank", "name": name, "number": encrypt(number), "last4": number[-4:], "ifsc": ifsc}
    raise ApiError(400, "Please tell us where to send your refund: a UPI ID or a bank account")


async def request_return(user_id: int, order_id: int, body: dict) -> dict:
    # The older client sends only `reason`; that counts as "other"
    code = body.get("reasonCode") if body.get("reasonCode") in RETURN_REASONS else ("other" if (body.get("reason") or "").strip() else None)
    if not code:
        raise ApiError(400, "Please choose why you are returning this order")
    details = (body.get("details") if body.get("details") is not None else body.get("reason") or "").strip()[:500]
    if code == "other" and len(details) < 3:
        raise ApiError(400, "Please tell us why you are returning this order")

    pool = get_pool()
    order = await pool.fetchrow(
        """SELECT o.id, o.status, o.total, bool_and(oi.fulfilment = 'delivered') AS delivered, MAX(oi.fulfilled_at) AS delivered_at,
                  EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'paid') AS paid_online
             FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.id = $1 AND o.user_id = $2 GROUP BY o.id""",
        order_id,
        user_id,
    )
    if not order:
        raise ApiError(404, "Order not found")
    if order["status"] != "placed":
        raise ApiError(400, f"This order was {order['status']}, so it can’t be returned")
    if not order["delivered"]:
        raise ApiError(400, "You can return an order once it has been delivered")
    if order["delivered_at"] and datetime.now(UTC) - order["delivered_at"] > timedelta(days=RETURN_WINDOW_DAYS):
        raise ApiError(
            400,
            f"The {RETURN_WINDOW_DAYS}-day return window for this order has closed. Please contact support if something is wrong with it.",
        )

    account = {"to": "original"} if order["paid_online"] else _refund_account(body)
    reason = f"{RETURN_REASONS[code]}: {details}" if details else RETURN_REASONS[code]
    saved = await pool.fetchrow(
        """INSERT INTO order_returns (order_id, user_id, reason, reason_code, amount, refund_to, refund_upi,
                                     refund_account_name, refund_account_number, refund_account_last4, refund_ifsc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (order_id) DO UPDATE SET
             reason = EXCLUDED.reason, reason_code = EXCLUDED.reason_code, amount = EXCLUDED.amount,
             refund_to = EXCLUDED.refund_to, refund_upi = EXCLUDED.refund_upi, refund_account_name = EXCLUDED.refund_account_name,
             refund_account_number = EXCLUDED.refund_account_number, refund_account_last4 = EXCLUDED.refund_account_last4,
             refund_ifsc = EXCLUDED.refund_ifsc, status = 'requested', refund = NULL, refund_reference = NULL, note = NULL,
             created_at = NOW(), updated_at = NOW(), resolved_at = NULL, refunded_at = NULL
           WHERE order_returns.status = 'withdrawn'
           RETURNING *""",
        order["id"],
        user_id,
        reason,
        code,
        order["total"],
        account["to"],
        account.get("upi"),
        account.get("name"),
        account.get("number"),
        account.get("last4"),
        account.get("ifsc"),
    )
    if not saved:
        raise ApiError(409, "A return has already been requested for this order")
    await add_event(pool, order["id"], "return_requested", f"Return requested: {RETURN_REASONS[code]}")
    return return_json(saved)


async def withdraw(user_id: int, order_id: int) -> None:
    pool = get_pool()
    gone = await pool.fetchrow(
        """UPDATE order_returns SET status = 'withdrawn', refund_account_number = NULL, updated_at = NOW()
            WHERE order_id = $1 AND user_id = $2 AND status = 'requested' RETURNING order_id""",
        order_id,
        user_id,
    )
    if not gone:
        raise ApiError(400, "This return can no longer be withdrawn. Our courier may already be on the way.")
    await add_event(pool, order_id, "return_withdrawn", "You withdrew your return request")


async def list_returns(user_id: int, admin: bool, view: str = "open") -> list[dict]:
    records = await get_pool().fetch(
        f"""SELECT r.*, o.total, o.payment_method, o.address, split_part(o.address, ',', 1) AS customer,
                   json_agg(json_build_object('name', oi.name, 'image', oi.image, 'qty', oi.qty, 'price', oi.price)
                            ORDER BY oi.id) AS items,
                   bool_and(oi.seller_id IS NOT DISTINCT FROM $1::int) AS all_mine
              FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN order_items oi ON oi.order_id = o.id
             WHERE r.status <> 'withdrawn' {"" if view == "all" else f"AND {OPEN}"}
             GROUP BY r.id, o.id
            HAVING $2::boolean OR bool_or(oi.seller_id = $1::int)
             ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'approved' THEN 1 WHEN 'received' THEN 2 ELSE 3 END, r.created_at DESC
             LIMIT 200""",
        user_id,
        admin,
    )
    return [
        {
            **return_json(r, admin),
            "total": float(r["total"]),
            "payment_method": r["payment_method"],
            "customer": r["customer"],
            "address": r["address"],
            "items": r["items"],
            "canManage": admin or r["all_mine"],
            "canRecordRefund": admin,
        }
        for r in records
    ]


async def _record_refund(r, refund: str) -> None:
    pool = get_pool()
    await pool.execute(
        """UPDATE order_returns SET refund = $1::varchar, updated_at = NOW(),
                  refunded_at = CASE WHEN $1::varchar = 'refunded' THEN NOW() END
            WHERE id = $2""",
        refund,
        r["id"],
    )
    amount = _rupees(r["amount"] if r["amount"] is not None else r["total"])
    notes = {
        "refunded": f"Refund of {amount} sent to {_destination(r)}. Banks usually show it within 5–7 working days.",
        "refund_pending": f"Refund of {amount} to {_destination(r)} is being processed.",
        "cod_manual": f"Refund of {amount} will be sent to {_destination(r)} within 2 working days.",
    }
    await add_event(pool, r["order_id"], "refunded" if refund == "refunded" else "refund_initiated", notes[refund])


async def _refund_online(order_id: int) -> str:
    status = await refund_order(order_id)
    if status:
        return status
    done = await get_pool().fetchval("SELECT 1 FROM payments WHERE order_id = $1 AND status = 'refunded'", order_id)
    return "refunded" if done else "refund_pending"


async def act(user_id: int, admin: bool, order_id: int, action: str, note: str | None = None, reference: str | None = None) -> dict:
    if action not in ACTIONS:
        raise ApiError(400, "Unknown action")
    pool = get_pool()
    r = await pool.fetchrow(
        """SELECT r.*, o.total, bool_and(oi.seller_id IS NOT DISTINCT FROM $2::int) AS all_mine, bool_or(oi.seller_id = $2::int) AS any_mine
             FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN order_items oi ON oi.order_id = o.id
            WHERE r.order_id = $1 AND r.status <> 'withdrawn' GROUP BY r.id, o.id""",
        order_id,
        user_id,
    )
    if not r or (not admin and not r["any_mine"]):
        raise ApiError(404, "Return not found")
    if not admin and not r["all_mine"]:
        raise ApiError(403, "This order has other sellers’ items too, so the store team handles its return.")
    note = (note or "").strip()[:500] or None

    async def step(from_status: str, assignment: str, *extra):
        # Each step moves on only from the one before, so a double click or two people at once can't repeat it
        return await pool.fetchrow(
            f"UPDATE order_returns SET {assignment}, updated_at = NOW() WHERE id = $1 AND status = $2 RETURNING *",
            r["id"],
            from_status,
            *extra,
        )

    if action == "approve":
        done = await step("requested", "status = 'approved', note = COALESCE($3, note)", note)
        if not done:
            raise ApiError(409, f"This return is already {r['status']}")
        await add_event(
            pool,
            order_id,
            "return_approved",
            f"Return approved. Our courier will pick the item up in 2–3 days.{f' {note}' if note else ''}",
        )
        return return_json(done, admin)

    if action == "reject":
        if not note or len(note) < 5:
            raise ApiError(400, "Please tell the customer why the return isn’t approved")
        done = await step("requested", "status = 'rejected', note = $3, resolved_at = NOW(), refund_account_number = NULL", note)
        if not done:
            raise ApiError(409, f"This return is already {r['status']}")
        await add_event(pool, order_id, "return_rejected", f"Return not approved: {note}")
        return return_json(done, admin)

    if action == "receive":
        done = await step("approved", "status = 'received', resolved_at = NOW(), note = COALESCE($3, note)", note)
        if not done:
            raise ApiError(
                409,
                "Approve the return before marking it received" if r["status"] == "requested" else f"This return is already {r['status']}",
            )
        await pool.execute("UPDATE orders SET status = 'returned' WHERE id = $1", order_id)
        await return_stock(order_id)  # the item is back on the shelf
        await add_event(pool, order_id, "returned", "Item picked up and returned")
        refund = await _refund_online(order_id) if done["refund_to"] == "original" else "cod_manual"
        await _record_refund({**dict(done), "total": r["total"]}, refund)
        return return_json(await pool.fetchrow("SELECT * FROM order_returns WHERE id = $1", r["id"]), admin)

    # refund: retry an online refund that didn't go through, or record a manual bank / UPI transfer
    if r["status"] != "received" or r["refund"] == "refunded":
        raise ApiError(409, "This return has already been refunded" if r["refund"] == "refunded" else "Mark the item received first")
    if r["refund_to"] == "original":
        claimed = await pool.fetchval(
            """UPDATE order_returns SET refund = 'processing', updated_at = NOW()
                WHERE id = $1 AND refund IS DISTINCT FROM 'refunded' AND refund IS DISTINCT FROM 'processing' RETURNING id""",
            r["id"],
        )
        if not claimed:
            raise ApiError(409, "This refund is already being sent")
        await _record_refund(r, await _refund_online(order_id))
    else:
        if not admin:
            raise ApiError(403, "Only the store admin can record a bank or UPI refund")
        reference = (reference or "").strip().upper()
        if not UTR_RE.match(reference):
            raise ApiError(400, "Enter the UTR or reference number of the transfer")
        done = await pool.fetchrow(
            """UPDATE order_returns SET refund = 'refunded', refund_reference = $2, refunded_at = NOW(), refund_account_number = NULL,
                      updated_at = NOW()
                WHERE id = $1 AND status = 'received' AND refund = 'cod_manual' RETURNING *""",
            r["id"],
            reference,
        )
        if not done:
            raise ApiError(409, "This refund has already been recorded")
        amount = _rupees(done["amount"] if done["amount"] is not None else r["total"])
        await add_event(pool, order_id, "refunded", f"Refund of {amount} sent to {_destination(done)} (reference {reference}).")
    return return_json(await pool.fetchrow("SELECT * FROM order_returns WHERE id = $1", r["id"]), admin)
