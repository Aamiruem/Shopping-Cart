"""Retrieval-augmented product Q&A (RAG).

Documents = one passage per product + one per section of the store policies.
Retrieval uses TF-IDF so it runs with no external services; replace it with an
embedding model and a vector store (e.g. MongoDB Atlas Vector Search, pgvector
or OpenSearch on AWS) for larger catalogs. Generation uses Claude when an
ANTHROPIC_API_KEY is set; otherwise the top passages are returned as-is.
"""
from pathlib import Path

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from . import llm
from .catalog import product_text

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "knowledge"

SYSTEM_PROMPT = (
    "You are the customer support assistant for an online store. Answer the "
    "customer's question using only the passages provided. If the passages do "
    "not contain the answer, say you don't know and suggest contacting support. "
    "Quote prices in rupees. Keep answers short and friendly."
)


def load_policy_passages() -> list[dict]:
    passages = []
    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        for section in path.read_text(encoding="utf-8").split("\n# "):
            section = section.lstrip("# ").strip()
            if section:
                title, _, body = section.partition("\n")
                passages.append({"source": f"{path.stem}: {title}", "text": f"{title}. {body.strip()}"})
    return passages


class RagIndex:
    def __init__(self, products: list[dict]):
        product_passages = [
            {"source": f"product: {p['name']}", "text": f"{product_text(p)} Price: Rs {p['price']}. In stock: {p.get('stock', 0)}."}
            for p in products
        ]
        self.passages = product_passages + load_policy_passages()
        self.vectorizer = TfidfVectorizer(stop_words="english")
        self.matrix = self.vectorizer.fit_transform([p["text"] for p in self.passages])

    def retrieve(self, question: str, k: int = 4) -> list[dict]:
        scores = cosine_similarity(self.vectorizer.transform([question]), self.matrix).ravel()
        top = scores.argsort()[::-1][:k]
        return [{**self.passages[i], "score": round(float(scores[i]), 3)} for i in top if scores[i] > 0]

    def ask(self, question: str) -> dict:
        passages = self.retrieve(question)
        if not llm.enabled():
            answer = passages[0]["text"] if passages else "Sorry, I couldn't find anything about that."
            return {"answer": answer, "sources": passages, "llm": False}

        context = "\n\n".join(f"[{p['source']}]\n{p['text']}" for p in passages) or "(no passages found)"
        answer = llm.complete(SYSTEM_PROMPT, f"Passages:\n{context}\n\nQuestion: {question}")
        return {"answer": answer, "sources": passages, "llm": True}
