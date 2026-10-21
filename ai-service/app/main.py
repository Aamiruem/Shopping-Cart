"""AI service: ML recommendations, RAG Q&A and an agentic shopping assistant."""
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import llm
from .agent import ShoppingAgent
from .catalog import get_products
from .rag import RagIndex
from .recommender import Recommender

app = FastAPI(title="Shop AI Service")
state: dict = {}


def models(refresh: bool = False):
    """Builds the ML/RAG indexes from the live catalog (lazily, and on refresh)."""
    if refresh or "recommender" not in state:
        products = get_products(force=refresh)
        state["recommender"] = Recommender(products)
        state["rag"] = RagIndex(products)
    return state["recommender"], state["rag"]


class Question(BaseModel):
    question: str


class CartIds(BaseModel):
    product_ids: list[str]
    k: int = 4


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


@app.get("/health")
def health():
    return {"ok": True, "llm_enabled": llm.enabled()}


@app.post("/reindex")
def reindex():
    recommender, rag = models(refresh=True)
    return {"products": len(recommender.products), "passages": len(rag.passages)}


@app.get("/recommend/{product_id}")
def recommend(product_id: str, k: int = 4):
    recommender, _ = models()
    return recommender.similar(product_id, k)


@app.post("/recommend/cart")
def recommend_for_cart(body: CartIds):
    recommender, _ = models()
    return recommender.for_cart(body.product_ids, body.k)


@app.post("/rag/ask")
def ask(body: Question):
    _, rag = models()
    return rag.ask(body.question)


@app.post("/agent/chat")
def agent_chat(body: ChatRequest, authorization: str = Header(default="")):
    if not llm.enabled():
        raise HTTPException(503, "Set ANTHROPIC_API_KEY to enable the shopping assistant")
    if not body.messages or body.messages[-1].role != "user":
        raise HTTPException(400, "The last message must be from the user")
    recommender, rag = models()
    agent = ShoppingAgent(recommender, rag, authorization)
    return agent.chat([m.model_dump() for m in body.messages])
