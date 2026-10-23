"""Agentic AI: the shopping assistant (acts on the shopper's cart) and the data analyst (text-to-SQL)."""

from fastapi import APIRouter, Depends, Header, HTTPException

from ...agents.analyst import SUGGESTED_QUESTIONS, DataAnalyst
from ...agents.shopping import ShoppingAgent
from ...agents.sql_guard import UnsafeSQL
from ...core.security import User, current_user, require_seller, seller_scope
from ...llm import client as llm
from ...ml.registry import models
from ..schemas import AnalystQuestion, ChatRequest

router = APIRouter(tags=["agents"])


@router.post("/agent/chat")
def agent_chat(body: ChatRequest, user: User = Depends(current_user), authorization: str = Header(default="")):
    if not llm.enabled():
        raise HTTPException(503, "Set ANTHROPIC_API_KEY to enable the shopping assistant")
    if not body.messages or body.messages[-1].role != "user":
        raise HTTPException(400, "The last message must be from the user")
    recommender, rag = models()
    agent = ShoppingAgent(recommender, rag, authorization)  # the shopper's own token: it can only touch their cart
    return agent.chat([m.model_dump() for m in body.messages])


@router.get("/analyst/suggestions")
def analyst_suggestions(_: User = Depends(require_seller)):
    return {"questions": SUGGESTED_QUESTIONS, "llm": llm.enabled()}


@router.post("/analyst/ask")
def analyst_ask(body: AnalystQuestion, user: User = Depends(require_seller)):
    try:
        return DataAnalyst(seller_scope(user, body.sellerId)).ask(body.question)
    except UnsafeSQL as e:  # a template query failing is a server problem, not the user's
        raise HTTPException(500, f"Analysis failed: {e}") from None
