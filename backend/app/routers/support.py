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
    order = (
        "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at DESC" if role == "admin" else "t.created_at DESC"
    )
    records = await get_pool().fetch(
        f"""SELECT t.*, u.name AS customer_name FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
            {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY {order} LIMIT 200""",
        *params,
    )
    return [{**r, "categoryLabel": support_ml.CATEGORY_LABELS.get(r["category"], r["category"])} for r in rows(records)]


@router.patch("/tickets/{ticket_id}")
async def update_ticket(ticket_id: int, body: TicketUpdate, _: CurrentUser = Depends(require_admin)):
    if body.status not in STATUSES:
        raise ApiError(400, f"status must be one of: {', '.join(STATUSES)}")
    ticket = await get_pool().fetchrow(
        """UPDATE support_tickets SET status = $1::varchar, resolved_at = CASE WHEN $1::varchar = 'resolved' THEN NOW() ELSE NULL END
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
