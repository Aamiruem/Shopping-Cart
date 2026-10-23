"""RAG step 3 - generation: retrieve passages, then let Claude answer from them with numbered citations.

Without an ANTHROPIC_API_KEY the best passage is returned as the answer, so support still works in development.
"""

from ..llm import client as llm
from .documents import policy_passages, product_passages
from .retriever import HybridRetriever

SYSTEM_PROMPT = (
    "You are the customer support assistant for Arvixa, an Indian online store. Answer the customer's question "
    "using only the numbered passages provided, and cite them like [1] or [2]. If the passages don't contain the "
    "answer, say you don't know and suggest contacting support. Quote prices in rupees (₹). Keep answers short "
    "and friendly."
)


class RagIndex:
    def __init__(self, products: list[dict]):
        self.passages = product_passages(products) + policy_passages()
        self.retriever = HybridRetriever([p["text"] for p in self.passages])

    def retrieve(self, question: str, k: int = 4) -> list[dict]:
        return [{**self.passages[i], "score": round(score, 4)} for i, score, _ in self.retriever.search(question, k)]

    def ask(self, question: str) -> dict:
        passages = self.retrieve(question)
        if not llm.enabled():
            answer = passages[0]["text"] if passages else "Sorry, I couldn't find anything about that."
            return {"answer": answer, "sources": passages, "llm": False}

        context = "\n\n".join(f"[{n}] ({p['source']})\n{p['text']}" for n, p in enumerate(passages, 1)) or "(no passages found)"
        answer = llm.complete(SYSTEM_PROMPT, f"Passages:\n{context}\n\nQuestion: {question}")
        return {"answer": answer, "sources": passages, "llm": True}
