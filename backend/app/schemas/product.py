"""Validated product input for seller / admin create and update."""

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from ..services.catalog import CATEGORIES

# Media must be an https link or a file uploaded to this store
MEDIA_URL = re.compile(r"^(https?://\S+|/api/uploads/[\w.-]+|/catalog/[\w.-]+)$")  # /catalog/ = images shipped with the store


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    description: str = Field(default="", max_length=5000)
    category: str
    subCategory: str = Field(default="", max_length=60)
    brand: str = Field(default="", max_length=80)
    tags: list[str] = Field(default_factory=list, max_length=20)
    price: float = Field(gt=0, le=10_000_000)
    mrp: float | None = Field(default=None, gt=0, le=10_000_000)
    stock: int = Field(default=0, ge=0, le=1_000_000)
    image: str = Field(default="", max_length=1000)
    images: list[str] = Field(default_factory=list, max_length=8)
    # Frames of a turntable shot in rotation order; 4+ frames enable the 360° viewer
    images360: list[str] = Field(default_factory=list, max_length=72)
    # Who a fashion item is for (drives the Women / Men filters); empty for everything else
    audience: Literal["", "women", "men", "unisex"] = ""
    # Product videos (MP4 / WebM) and an audio clip (e.g. a sound sample or a spoken description)
    videos: list[str] = Field(default_factory=list, max_length=4)
    audio: str = Field(default="", max_length=1000)
    unit: str = Field(default="", max_length=40)  # pack size, e.g. "500 g" or "1 L"
    # Clothing & footwear details: shoppers pick a size (and colour) before adding to cart
    sizes: list[str] = Field(default_factory=list, max_length=20)  # e.g. ["S", "M", "L"] or ["28", "30", "32"]
    colors: list[str] = Field(default_factory=list, max_length=20)
    ageGroups: list[Literal["18-25", "26-35", "36-50", "50+"]] = Field(default_factory=list, max_length=4)
    material: str = Field(default="", max_length=80)
    fit: str = Field(default="", max_length=40)  # e.g. Slim, Regular, Relaxed
    active: bool = True
    featured: bool = False  # only admins may set this

    @field_validator("name", "brand", "description", "subCategory")
    @classmethod
    def strip(cls, value: str) -> str:
        return value.strip()

    @field_validator("category")
    @classmethod
    def known_category(cls, value: str) -> str:
        if value not in CATEGORIES:
            raise ValueError(f"must be one of: {', '.join(CATEGORIES)}")
        return value

    @field_validator("videos", "images", "images360")
    @classmethod
    def media_urls(cls, value: list[str]) -> list[str]:
        bad = [u for u in value if not MEDIA_URL.match(u)]
        if bad:
            raise ValueError("media must be https links or uploaded files")
        return value

    @field_validator("audio", "image")
    @classmethod
    def media_url(cls, value: str) -> str:
        if value and not MEDIA_URL.match(value):
            raise ValueError("media must be an https link or an uploaded file")
        return value

    @field_validator("sizes", "colors")
    @classmethod
    def clean_options(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(v.strip()[:20] for v in value if v and v.strip()))

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(t.strip().lower() for t in value if t.strip()))[:20]

    @model_validator(mode="after")
    def mrp_not_below_price(self):
        if self.mrp is not None and self.mrp < self.price:
            raise ValueError("MRP cannot be lower than the selling price")
        if not self.image and self.images:
            self.image = self.images[0]
        if 0 < len(self.images360) < 4:
            raise ValueError("A 360° view needs at least 4 frames")
        return self


class ProductPatch(BaseModel):
    """Quick edits from the seller product table."""

    price: float | None = Field(default=None, gt=0, le=10_000_000)
    mrp: float | None = Field(default=None, gt=0, le=10_000_000)
    stock: int | None = Field(default=None, ge=0, le=1_000_000)
    active: bool | None = None
