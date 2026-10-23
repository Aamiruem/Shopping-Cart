"""RAG step 1 - documents: turn the catalog and the store's knowledge base into small, citable passages."""

from pathlib import Path

from ..services.catalog import product_text

KNOWLEDGE_DIR = Path(__file__).resolve().parents[2] / "knowledge"
CHUNK_WORDS = 120  # long policy sections are split so each passage stays focused on one idea
OVERLAP_WORDS = 30  # ...with some overlap, so a sentence cut at a boundary still appears whole once


def chunk(text: str, size: int = CHUNK_WORDS, overlap: int = OVERLAP_WORDS) -> list[str]:
    words = text.split()
    if len(words) <= size:
        return [text.strip()] if text.strip() else []
    step = size - overlap
    return [" ".join(words[i : i + size]) for i in range(0, max(len(words) - overlap, 1), step)]


def policy_passages(knowledge_dir: Path = KNOWLEDGE_DIR) -> list[dict]:
    """One passage per chunk of every '# Section' in knowledge/*.md."""
    passages = []
    for path in sorted(knowledge_dir.glob("*.md")):
        for section in path.read_text(encoding="utf-8").split("\n# "):
            section = section.lstrip("# ").strip()
            if not section:
                continue
            title, _, body = section.partition("\n")
            for i, part in enumerate(chunk(body.strip()) or [""]):
                source = f"{path.stem}: {title}" + (f" (part {i + 1})" if i else "")
                passages.append({"source": source, "text": f"{title}. {part}".strip(), "kind": "policy"})
    return passages


def product_passages(products: list[dict]) -> list[dict]:
    return [
        {
            "source": f"product: {p['name']}",
            "text": f"{product_text(p)} Price: Rs {p['price']}. In stock: {p.get('stock', 0)}.",
            "kind": "product",
            "productId": str(p.get("_id", "")),
        }
        for p in products
    ]
