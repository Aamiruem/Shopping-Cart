"""/api/support - customer support tickets with automatic ML triage."""

import asyncio

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.lazy import lazy_import
from ..core.rate_limit import rate_limit
from ..db.postgres import get_pool, rows
from ..deps import CurrentUser, get_current_user, require_admin

support_ml = lazy_import("app.ml.support")  # scikit-learn loads on the first ticket, not at startup

router = APIRouter(prefix="/api/support", tags=["support"])
ticket_limiter = rate_limit(10, 60 * 60, "You've raised many tickets in the last hour. Our team will get back to you soon.")
STATUSES = ("open", "in_progress", "resolved")


class TicketIn(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    message: str = Field(min_length=10, max_length=4000)
    orderId: int | None = None


class TicketUpdate(BaseModel):
    status: str


class ReplyIn(BaseModel):
    message: str = Field(min_length=2, max_length=4000)


reply_limiter = rate_limit(60, message="Too many replies just now. Please try again in 15 minutes.")


async def _knowledge_answer(question: str) -> str | None:
    """Asks the AI service's RAG endpoint (store policies + catalog). Optional - returns None if unavailable."""
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            response = await client.post(f"{get_settings().ai_service_url}/rag/ask", json={"question": question})
        return response.json().get("answer") if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


@router.post("/tickets", status_code=201, dependencies=[Depends(ticket_limiter)])
async def create_ticket(body: TicketIn, user: CurrentUser = Depends(get_current_user)):
    pool = get_pool()
    name = await pool.fetchval("SELECT name FROM users WHERE id = $1", user.id) or "there"
    if body.orderId and not await pool.fetchval("SELECT 1 FROM orders WHERE id = $1 AND user_id = $2", body.orderId, user.id):
        raise ApiError(404, "Order not found")

    triage = await asyncio.to_thread(support_ml.triage, body.subject, body.message, name, body.orderId)
    answer = await _knowledge_answer(f"{body.subject}. {body.message}")
    reply = triage["suggestedReply"] + (f"\n\nFrom our help centre: {answer}" if answer else "")

    ticket = await pool.fetchrow(
        """INSERT INTO support_tickets (user_id, order_id, subject, message, category, category_confidence, sentiment, priority,
                                      suggested_reply)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *""",
        user.id,
        body.orderId,
        body.subject.strip(),
        body.message.strip(),
        triage["category"],
        triage["confidence"],
        triage["sentiment"],
        triage["priority"],
        reply,
    )
    return {**dict(ticket), "categoryLabel": triage["categoryLabel"]}


@router.get("/tickets")
async def list_tickets(status: str | None = None, user: CurrentUser = Depends(get_current_user)):
    """Shoppers see their own tickets; admins see every ticket (highest priority first)."""
    role = await get_pool().fetchval("SELECT role FROM users WHERE id = $1", user.id)
    params: list = []
    where = []
    if role != "admin":
        params.append(user.id)
        where.append(f"t.user_id = ${len(params)}")
    if status in STATUSES:
        params.append(status)
        where.append(f"t.status = ${len(params)}")
    # Admins: unresolved first, then the most urgent, then the latest activity
    urgent_first = "CASE t.status WHEN 'resolved' THEN 1 ELSE 0 END, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END"
    order = f"{urgent_first}, t.updated_at DESC" if role == "admin" else "t.updated_at DESC"
    records = await get_pool().fetch(
        f"""SELECT t.*, u.name AS customer_name,
                   (SELECT count(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS replies,
                   (SELECT m.staff FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
                     AS last_from_staff
              FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
            {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {order} LIMIT 200""",
        *params,
    )
    return [{**r, "categoryLabel": support_ml.CATEGORY_LABELS.get(r["category"], r["category"])} for r in rows(records)]


@router.patch("/tickets/{ticket_id}")
async def update_ticket(ticket_id: int, body: TicketUpdate, _: CurrentUser = Depends(require_admin)):
    if body.status not in STATUSES:
        raise ApiError(400, f"status must be one of: {', '.join(STATUSES)}")
    ticket = await get_pool().fetchrow(
        """UPDATE support_tickets SET status = $1::varchar, updated_at = NOW(),
                  resolved_at = CASE WHEN $1::varchar = 'resolved' THEN NOW() ELSE NULL END
           WHERE id = $2 RETURNING *""",
        body.status,
        ticket_id,
    )
    if not ticket:
        raise ApiError(404, "Ticket not found")
    return dict(ticket)


@router.post("/triage")
async def preview_triage(body: TicketIn, _: CurrentUser = Depends(get_current_user)):
    """Shows what the triage model thinks of a message before it is submitted (used by the help form)."""
    return await asyncio.to_thread(support_ml.triage, body.subject, body.message)


# ---------- The conversation on a ticket (same as api/_support.mjs) ----------


async def _visible_ticket(ticket_id: int, user: CurrentUser) -> tuple[dict, str]:
    """The ticket, if this person may see it: its owner, or an admin."""
    pool = get_pool()
    role = await pool.fetchval("SELECT role FROM users WHERE id = $1", user.id)
    ticket = await pool.fetchrow(
        """SELECT t.*, u.name AS customer_name, u.email AS customer_email
             FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1""",
        ticket_id,
    )
    if not ticket or (role != "admin" and ticket["user_id"] != user.id):
        raise ApiError(404, "Ticket not found")
    found = dict(ticket)
    if role != "admin":
        found.pop("customer_email")
    return found, role


@router.get("/tickets/{ticket_id}")
async def get_ticket(ticket_id: int, user: CurrentUser = Depends(get_current_user)):
    ticket, _ = await _visible_ticket(ticket_id, user)
    messages = await get_pool().fetch(
        """SELECT m.id, m.staff, m.body, m.created_at, CASE WHEN m.staff THEN 'Arvixa support' ELSE u.name END AS author
             FROM ticket_messages m LEFT JOIN users u ON u.id = m.user_id
            WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id""",
        ticket_id,
    )
    label = support_ml.CATEGORY_LABELS.get(ticket["category"], ticket["category"])
    return {**ticket, "categoryLabel": label, "messages": rows(messages)}


@router.post("/tickets/{ticket_id}/messages", dependencies=[Depends(reply_limiter)])
async def reply(ticket_id: int, body: ReplyIn, user: CurrentUser = Depends(get_current_user)):
    """A reply. Staff replying moves an open ticket to in_progress; the shopper replying reopens a resolved one."""
    ticket, role = await _visible_ticket(ticket_id, user)
    staff = role == "admin" and ticket["user_id"] != user.id
    if staff:
        status = "in_progress" if ticket["status"] == "open" else ticket["status"]
    else:
        status = "open" if ticket["status"] == "resolved" else ticket["status"]
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO ticket_messages (ticket_id, user_id, staff, body) VALUES ($1, $2, $3, $4)",
            ticket_id,
            user.id,
            staff,
            body.message.strip(),
        )
        await conn.execute(
            """UPDATE support_tickets SET status = $1::varchar, updated_at = NOW(),
                      resolved_at = CASE WHEN $1::varchar = 'resolved' THEN resolved_at ELSE NULL END
                WHERE id = $2""",
            status,
            ticket_id,
        )
    return await get_ticket(ticket_id, user)
