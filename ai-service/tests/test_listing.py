"""Listing writer: the template path (tests run without an API key)."""

from app import listing


def test_template_listing_without_api_key(monkeypatch):
    monkeypatch.setattr(listing.llm, "enabled", lambda: False)
    out = listing.generate({
        "name": "cotton kurta", "brand": "Ethnix", "category": "fashion", "audience": "women", "unit": "Size M",
        "price": 799, "description": "Soft cotton, hand block print.", "tags": ["Kurta"],
    })
    assert out["source"] == "template"
    assert out["title"].startswith("Ethnix cotton kurta") and "(Size M)" in out["title"]
    assert "kurta" in out["tags"] and "ethnix" in out["tags"] and len(out["tags"]) <= 10
    assert "799" in out["metaDescription"] and len(out["metaDescription"]) <= 160
    assert out["highlights"] and "for women" in out["description"]


def test_claude_path_uses_structured_output(monkeypatch):
    calls = {}

    def fake_structured(system, prompt, schema, effort="low"):
        calls.update(system=system, prompt=prompt, schema=schema)
        return {"title": "T", "description": "D", "highlights": ["H"], "tags": ["t"], "metaDescription": "M"}

    monkeypatch.setattr(listing.llm, "enabled", lambda: True)
    monkeypatch.setattr(listing.llm, "structured", fake_structured)
    out = listing.generate({"name": "Steel Bottle", "brand": "Steelcraft", "price": 499})
    assert out["source"] == "claude" and out["title"] == "T"
    assert "Steelcraft" in calls["prompt"] and calls["schema"]["additionalProperties"] is False
    assert "never invent" in calls["system"]
