"""Semantic search, photo search, image quality checks and review analysis."""

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from ...cv.vision import InvalidImage, quality_report
from ...ml.registry import semantic_index, visual_index
from ...nlp.reviews import summarize
from ..schemas import ReviewBatch

router = APIRouter(tags=["intelligence"])
MAX_IMAGE_BYTES = 8 * 1024 * 1024


async def _read_image(file: UploadFile) -> bytes:
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Please use an image under 8 MB")
    return data


@router.get("/search/semantic")
def semantic_search(q: str = Query(min_length=2, max_length=200), k: int = Query(default=12, ge=1, le=40)):
    return semantic_index().search(q, k)


@router.post("/vision/search")
async def visual_search(file: UploadFile = File(...), k: int = Query(default=12, ge=1, le=40)):
    index = visual_index()
    if not index.ready:
        raise HTTPException(503, "Photo search is not available right now")
    try:
        return index.search(await _read_image(file), k)
    except InvalidImage as err:
        raise HTTPException(400, str(err)) from None


@router.post("/vision/quality")
async def image_quality(file: UploadFile = File(...)):
    try:
        return quality_report(await _read_image(file))
    except InvalidImage as err:
        raise HTTPException(400, str(err)) from None


@router.post("/nlp/review-summary")
def review_summary(body: ReviewBatch):
    return summarize([r.model_dump() for r in body.reviews])
