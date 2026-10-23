"""Bulk product import: one CSV row per product + the photos / videos it names (ZIP upload or a server folder).

CSV columns (header names are case-insensitive; * = required; lists use "|"):
  name*, price*, images* (e.g. "front.jpg|back.jpg|side.jpg|model.jpg"), brand, category (default fashion),
  audience (women/men/unisex), subCategory, ageGroups (18-25|26-35|36-50|50+), sizes (S|M|L|XL or 28|30|32),
  colors (Black|Navy), material, fit, mrp, stock, tags, description, video (one or more .mp4/.webm), unit
Media names are matched against the files in the ZIP / folder by file name (any sub-folder, any case);
https:// links are used as they are. Photos are optimised (upright, max 1600 px, WebP) on the way in.
"""

import csv
import io
import mimetypes
import zipfile
from collections.abc import Callable
from pathlib import Path

from pydantic import ValidationError

from ..core.errors import ApiError
from ..deps import CurrentUser
from ..schemas.product import ProductIn
from . import products as product_service
from .storage import MEDIA, save_media

TEMPLATE_HEADERS = [
    "name",
    "brand",
    "category",
    "audience",
    "subCategory",
    "ageGroups",
    "sizes",
    "colors",
    "material",
    "fit",
    "price",
    "mrp",
    "stock",
    "images",
    "video",
    "tags",
    "description",
]
TEMPLATE_ROWS = [
    [
        "Men's Slim Fit Stretch Jeans",
        "Urban Thread",
        "fashion",
        "men",
        "mens-jeans",
        "18-25|26-35",
        "28|30|32|34|36",
        "Dark Blue|Black",
        "98% cotton, 2% elastane",
        "Slim",
        "1299",
        "2499",
        "120",
        "jeans-front.jpg|jeans-back.jpg|jeans-side.jpg|jeans-model.jpg",
        "jeans-walk.mp4",
        "jeans|denim|slim fit",
        "Comfortable stretch denim for all-day wear. Five-pocket styling, zip fly.",
    ],
    [
        "Women's Cotton Printed Kurta",
        "Ethnix",
        "fashion",
        "women",
        "womens-ethnic",
        "26-35|36-50",
        "S|M|L|XL|XXL",
        "Mustard|Teal",
        "100% cotton",
        "Regular",
        "799",
        "1599",
        "80",
        "kurta-front.jpg|kurta-back.jpg|kurta-model.jpg",
        "",
        "kurta|ethnic|cotton",
        "Breathable hand-block printed cotton kurta with three-quarter sleeves.",
    ],
]
MAX_ROWS = 1000
MAX_ZIP_TOTAL = 3 * 1024**3  # 3 GB uncompressed: guards against zip bombs


def template_csv() -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(TEMPLATE_HEADERS)
    writer.writerows(TEMPLATE_ROWS)
    return out.getvalue()


def _split(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").replace(",", "|").split("|") if v.strip()]


def parse_sheet(raw: bytes) -> list[dict]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")  # Excel "CSV" on Windows
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise ApiError(400, "The sheet is empty")
    headers = {h.strip().lower(): h for h in reader.fieldnames if h}
    missing = [h for h in ("name", "price", "images") if h not in headers]
    if missing:
        raise ApiError(400, f"The sheet needs these columns: {', '.join(missing)}. Download the template to start.")
    rows = [{k.strip().lower(): (v or "").strip() for k, v in row.items() if k} for row in reader]
    rows = [r for r in rows if any(r.values())]
    if not rows:
        raise ApiError(400, "The sheet has no product rows")
    if len(rows) > MAX_ROWS:
        raise ApiError(400, f"Up to {MAX_ROWS} products per import; split the sheet into smaller files")
    return rows


class MediaSource:
    """Looks media up by file name in a ZIP archive or a folder."""

    def __init__(self, files: dict[str, Callable[[], bytes]], archive: zipfile.ZipFile | None = None):
        self.files = files  # lower-case base name -> reader
        self._archive = archive

    def close(self) -> None:
        if self._archive:
            self._archive.close()

    @classmethod
    def from_zip(cls, path: Path) -> "MediaSource":
        archive = zipfile.ZipFile(path)
        total = sum(i.file_size for i in archive.infolist())
        if total > MAX_ZIP_TOTAL:
            raise ApiError(400, "The ZIP is too large once unpacked (max 3 GB)")
        files = {}
        for info in archive.infolist():
            if info.is_dir() or info.filename.startswith("__MACOSX/"):
                continue
            files[Path(info.filename).name.lower()] = lambda info=info: archive.read(info)  # never extracted to disk
        return cls(files, archive)

    @classmethod
    def from_folder(cls, folder: Path) -> "MediaSource":
        return cls({p.name.lower(): p.read_bytes for p in folder.rglob("*") if p.is_file()})

    @classmethod
    def empty(cls) -> "MediaSource":
        return cls({})

    def has(self, name: str) -> bool:
        return name.lower() in self.files

    def read(self, name: str) -> bytes:
        return self.files[name.lower()]()


def _kind_and_type(name: str) -> tuple[str, str]:
    ctype = mimetypes.guess_type(name)[0] or ""
    ctype = {"image/jpg": "image/jpeg", "audio/x-wav": "audio/wav"}.get(ctype, ctype)
    for kind, spec in MEDIA.items():
        if ctype in spec["types"]:
            return kind, ctype
    raise ApiError(400, f"{name}: unsupported file type (use JPEG/PNG/WebP photos and MP4/WebM videos)")


def _row_to_product(row: dict, media_urls: dict[str, str]) -> ProductIn:
    def url(name: str) -> str:
        return name if name.lower().startswith("https://") else media_urls[name.lower()]

    images = [url(n) for n in _split(row.get("images"))]
    data = {
        "name": row.get("name", ""),
        "brand": row.get("brand", ""),
        "category": (row.get("category") or "fashion").lower(),
        "subCategory": row.get("subcategory", ""),
        "audience": (row.get("audience") or "").lower(),
        "ageGroups": _split(row.get("agegroups")),
        "sizes": _split(row.get("sizes")),
        "colors": _split(row.get("colors")),
        "material": row.get("material", ""),
        "fit": row.get("fit", ""),
        "price": row.get("price") or 0,
        "mrp": row.get("mrp") or None,
        "stock": row.get("stock") or 10,
        "images": images,
        "image": images[0] if images else "",
        "videos": [url(n) for n in _split(row.get("video") or row.get("videos"))],
        "tags": _split(row.get("tags")),
        "description": row.get("description", ""),
        "unit": row.get("unit", ""),
    }
    if data["category"] == "fashion" and not data["audience"]:
        data["audience"] = "unisex"
    return ProductIn(**data)


def _friendly(err: ValidationError) -> str:
    first = err.errors()[0]
    field = ".".join(str(x) for x in first["loc"])
    return f"{field}: {first['msg']}"


async def run_import(
    rows: list[dict],
    media: MediaSource,
    actor: CurrentUser,
    dry_run: bool = False,
    progress: Callable[[int, list[dict]], object] | None = None,
) -> list[dict]:
    """Validates (and unless dry_run, creates) each row. Returns one result per row; never stops on a bad row."""
    results: list[dict] = []
    uploaded: dict[str, str] = {}  # file name -> stored URL (a photo shared by several rows is uploaded once)
    for index, row in enumerate(rows, start=2):  # row 1 is the header
        result = {"row": index, "name": row.get("name", "")}
        try:
            names = [
                n for n in _split(row.get("images")) + _split(row.get("video") or row.get("videos")) if not n.lower().startswith("https://")
            ]
            if not _split(row.get("images")):
                raise ApiError(400, "images: add at least one photo file name")
            missing = [n for n in names if not media.has(n)]
            if missing:
                raise ApiError(400, f"missing in the upload: {', '.join(missing[:5])}")
            for n in names:
                _kind_and_type(n)
            if dry_run:
                _row_to_product(row, {n.lower(): "/catalog/check.webp" for n in names})  # validate fields only
                result["status"] = "ok"
            else:
                for n in names:
                    if n.lower() not in uploaded:
                        kind, ctype = _kind_and_type(n)
                        uploaded[n.lower()] = await save_media(media.read(n), ctype, actor.id, kind)
                product = await product_service.create(_row_to_product(row, uploaded), actor)
                result.update(status="created", productId=product["_id"])
        except ValidationError as e:
            result.update(status="error", error=_friendly(e))
        except ApiError as e:
            result.update(status="error", error=e.message)
        results.append(result)
        if progress:
            await progress(index - 1, results)
    return results
