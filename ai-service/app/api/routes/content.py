"""Generative AI for sellers: the listing writer (Claude structured outputs, template fallback)."""

from fastapi import APIRouter, HTTPException

from ...services import listing
from ..schemas import ListingRequest

router = APIRouter(tags=["content"])


@router.post("/listing/generate")
def generate_listing(body: ListingRequest):
    """SEO title, description, highlights, tags and meta description from a seller's notes."""
    if len(body.name.strip()) < 2:
        raise HTTPException(400, "Enter the product name first")
    return listing.generate(body.model_dump())
