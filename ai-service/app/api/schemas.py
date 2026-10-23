"""Request bodies (pydantic validates every field before the handlers run)."""

from pydantic import BaseModel, Field


class Question(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class CartIds(BaseModel):
    product_ids: list[str]
    k: int = Field(default=4, ge=1, le=20)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


class AnalystQuestion(BaseModel):
    question: str = Field(min_length=3, max_length=500)
    sellerId: int | None = None  # admins only: one seller's data (sellers always see their own)


class ListingRequest(BaseModel):
    name: str
    brand: str = ""
    category: str = ""
    audience: str = ""
    unit: str = ""
    price: float | None = None
    mrp: float | None = None
    description: str = ""
    tags: list[str] = []
