"""Agentic shopping assistant.

Claude decides which tools to call (search, recommend, view cart, add to cart,
store policy lookup) and loops until it can answer. Cart tools call the Arvixa
backend with the shopper's own JWT, so the agent can only touch that user's cart.
"""

import json

import httpx

from ..core.config import get_settings
from ..llm import client as llm

MAX_STEPS = 8

SYSTEM_PROMPT = (
    "You are a helpful shopping assistant for an online store. Use the tools to "
    "find products, suggest alternatives, check store policies and manage the "
    "shopper's cart. Only add items to the cart when the shopper asks you to. "
    "Prices are in rupees. Keep replies short."
)

TOOLS = [
    {
        "name": "search_products",
        "description": "Search the catalog by keywords, optionally capped at a max price. Returns id, name, price, stock.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords, e.g. 'bluetooth headphones'"},
                "max_price": {"type": "number", "description": "Optional max price in rupees"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "recommend_similar",
        "description": "Get products similar to a product id (ML recommendations).",
        "input_schema": {
            "type": "object",
            "properties": {"product_id": {"type": "string"}},
            "required": ["product_id"],
        },
    },
    {
        "name": "store_policy",
        "description": "Look up shipping, returns, payment, warranty or tracking policy.",
        "input_schema": {
            "type": "object",
            "properties": {"question": {"type": "string"}},
            "required": ["question"],
        },
    },
    {
        "name": "view_cart",
        "description": "Show the shopper's current cart and total.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_to_cart",
        "description": "Add a product to the shopper's cart.",
        "input_schema": {
            "type": "object",
            "properties": {
                "product_id": {"type": "string"},
                "qty": {"type": "integer", "minimum": 1},
            },
            "required": ["product_id"],
        },
    },
]


class ShoppingAgent:
    def __init__(self, recommender, rag, auth_header: str):
        self.recommender = recommender
        self.rag = rag
        self.headers = {"Authorization": auth_header}

    # ---- tools -------------------------------------------------------------
    def search_products(self, query: str, max_price: float | None = None):
        words = [w for w in query.lower().split() if len(w) > 2]
        results = []
        for p in self.recommender.products:
            text = f"{p['name']} {p.get('description', '')} {' '.join(p.get('tags', []))} {p.get('category', '')}".lower()
            hits = sum(w in text for w in words)
            if hits and (max_price is None or p["price"] <= max_price):
                results.append((hits, p))
        results.sort(key=lambda r: -r[0])
        return [{"id": str(p["_id"]), "name": p["name"], "price": p["price"], "stock": p.get("stock")} for _, p in results[:6]]

    def recommend_similar(self, product_id: str):
        return [{"id": str(p["_id"]), "name": p["name"], "price": p["price"]} for p in self.recommender.similar(product_id)]

    def store_policy(self, question: str):
        return [p["text"] for p in self.rag.retrieve(question, k=2)]

    def view_cart(self):
        response = httpx.get(f"{get_settings().backend_url}/api/cart", headers=self.headers, timeout=10)
        return response.json()

    def add_to_cart(self, product_id: str, qty: int = 1):
        response = httpx.post(
            f"{get_settings().backend_url}/api/cart", headers=self.headers, json={"productId": product_id, "qty": qty}, timeout=10
        )
        return response.json()

    def run_tool(self, name: str, args: dict):
        tool = getattr(self, name, None)
        if name not in {t["name"] for t in TOOLS} or tool is None:
            return {"error": f"Unknown tool {name}"}, True
        try:
            return tool(**args), False
        except Exception as exc:  # report tool failures back to the model
            return {"error": str(exc)}, True

    # ---- loop --------------------------------------------------------------
    def chat(self, history: list[dict]) -> dict:
        """history: [{role: 'user'|'assistant', content: str}, ...] ending with the user's message."""
        messages = [{"role": m["role"], "content": m["content"]} for m in history]
        actions = []

        for _ in range(MAX_STEPS):
            response = llm.create(system=SYSTEM_PROMPT, tools=TOOLS, messages=messages)
            if response.stop_reason != "tool_use":
                return {"reply": llm.text_of(response), "actions": actions}

            messages.append({"role": "assistant", "content": response.content})
            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                output, is_error = self.run_tool(block.name, block.input)
                actions.append({"tool": block.name, "input": block.input})
                results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(output, default=str), "is_error": is_error}
                )
            messages.append({"role": "user", "content": results})

        return {"reply": "Sorry, that took too many steps. Could you rephrase?", "actions": actions}
