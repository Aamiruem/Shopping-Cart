"""Turn the catalog's snapshot photos into clean e-commerce packshots: product cut out, centred on white.

Works on the local /catalog/ images of every non-fashion product (fashion uses on-model photos, see
scripts.fashion_photos). Each picture is rewritten in place under the same name, so products.json and
the database need no change. Background removal is done on this machine by rembg (no API, no upload).

    pip install "rembg[cpu]" scipy    # once; ~170 MB model is downloaded on first run
    python scripts/packshots.py --out preview/   # write results to a folder to review first
    python scripts/packshots.py --apply          # overwrite frontend/public/catalog (originals are in git)

A photo whose cut-out looks unreliable (ragged edges, holes, product split into pieces, or almost
nothing / everything detected) is kept whole and just centred on the white square instead.
"""

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
PRODUCTS_FILE = ROOT / "backend" / "app" / "data" / "products.json"
CATALOG_DIR = ROOT / "frontend" / "public" / "catalog"
KEEP_WHOLE_FILE = Path(__file__).with_name("packshots_keep_whole.txt")  # cut-outs rejected on visual review
CANVAS = 800  # square, like Flipkart / Amazon listing images
FILL = 0.86  # share of the canvas the product's longer side takes


def catalog_files() -> list[Path]:
    products = json.loads(PRODUCTS_FILE.read_text(encoding="utf-8"))
    names = {
        src.rsplit("/", 1)[1]
        for p in products
        if p["category"] != "fashion"
        for src in [p["image"], *p.get("images", [])]
        if src.startswith("/catalog/")
    }
    return sorted(CATALOG_DIR / n for n in names)


def on_white(img: Image.Image) -> Image.Image:
    """Centres an RGBA image on a white square canvas, scaled so its longer side fills FILL of it."""
    scale = CANVAS * FILL / max(img.size)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", (CANVAS, CANVAS), "white")
    canvas.paste(img, ((CANVAS - img.width) // 2, (CANVAS - img.height) // 2), img)
    return canvas


def clean_mask(mask: np.ndarray) -> bool:
    """True when the cut-out is one solid shape. Shiny packets and busy scenes come back shredded:
    ragged edges, holes punched through the label, or the product split into pieces."""
    coverage = mask.mean()
    if not 0.04 <= coverage <= 0.92:
        return False
    holes = (ndimage.binary_fill_holes(mask).sum() - mask.sum()) / mask.sum()
    labels, _ = ndimage.label(mask)
    pieces = np.bincount(labels.ravel())[1:] / mask.sum()
    debris = pieces[pieces < 0.05].sum()  # pairs (earbuds, rings) are fine; confetti is not
    edge = mask ^ ndimage.binary_erosion(mask)
    roughness = edge.sum() ** 2 / mask.sum()  # perimeter² / area: ~13-27 for clean shapes, 35+ when shredded
    return roughness <= 40 and holes <= 0.04 and debris <= 0.03


def packshot(raw: bytes, session, keep_whole: bool = False) -> tuple[Image.Image, bool]:
    """Returns (packshot, cut_out); cut_out is False when the original was kept whole."""
    original = Image.open(io.BytesIO(raw)).convert("RGBA")
    if keep_whole:
        return on_white(original), False
    cut = remove(original, session=session, post_process_mask=True)
    mask = np.array(cut.getchannel("A")) > 32
    if not clean_mask(mask):
        return on_white(original), False
    return on_white(cut.crop(Image.fromarray(mask).getbbox())), True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--out", type=Path, help="write packshots to this folder for review")
    target.add_argument("--apply", action="store_true", help="overwrite the catalog images in place")
    parser.add_argument("--limit", type=int, help="only the first N images (quick trial)")
    parser.add_argument("--only", nargs="+", metavar="NAME", help="only these catalog file names")
    args = parser.parse_args()

    files = [f for f in catalog_files() if not args.only or f.name in args.only][: args.limit]
    keep_whole = {line.strip() for line in KEEP_WHOLE_FILE.read_text().splitlines() if line.strip() and not line.startswith("#")}
    session = new_session("isnet-general-use")
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
    kept = 0
    for i, path in enumerate(files, 1):
        image, cut_out = packshot(path.read_bytes(), session, keep_whole=path.name in keep_whole)
        kept += not cut_out
        dest = path if args.apply else args.out / path.name
        if path.suffix.lower() == ".png":
            image.save(dest, "PNG", optimize=True)
        else:
            image.save(dest, "JPEG", quality=90, optimize=True, progressive=True)
        print(f"[{i}/{len(files)}] {path.name}{'' if cut_out else '  (kept whole)'}", flush=True)
    print(f"Done: {len(files)} images, {len(files) - kept} cut out, {kept} kept whole")


if __name__ == "__main__":
    main()
