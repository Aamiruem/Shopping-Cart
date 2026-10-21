"""Validated product input for seller / admin create and update."""

from pydantic import BaseModel, Field, field_validator, model_validator

from ..services.catalog import CATEGORIES


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
        return self


class ProductPatch(BaseModel):
    """Quick edits from the seller product table."""

    price: float | None = Field(default=None, gt=0, le=10_000_000)
    mrp: float | None = Field(default=None, gt=0, le=10_000_000)
    stock: int | None = Field(default=None, ge=0, le=1_000_000)
    active: bool | None = None
