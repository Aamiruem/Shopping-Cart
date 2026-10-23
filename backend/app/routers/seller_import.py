"""/api/seller/imports - bulk product upload (CSV sheet + ZIP of photos / videos) for sellers.

A dry run checks every row and reports problems without creating anything. A real import runs as a
background job (status kept in MongoDB, so any API worker can answer the progress polls).
"""

import asyncio
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from bson import ObjectId
from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import Response

from ..core.errors import ApiError
from ..db.mongo import get_db
from ..deps import CurrentUser, require_seller
from ..services import bulk_import
from ..services.catalog import to_object_id

router = APIRouter(prefix="/api/seller/imports", tags=["seller"])
MAX_ZIP_BYTES = 1024**3  # 1 GB upload; bigger catalogues: python -m scripts.import_products (server folder)
_running: set[asyncio.Task] = set()  # keep references so background jobs aren't garbage-collected


@router.get("/template")
async def template(_: CurrentUser = Depends(require_seller)):
    return Response(
        bulk_import.template_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="arvixa-bulk-upload-template.csv"'},
    )


async def _save_zip(media: UploadFile) -> Path:
    if not media.filename.lower().endswith(".zip"):
        raise ApiError(400, "Photos and videos must be uploaded as one .zip file")
    fd, name = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    tmp = Path(name)
    with tmp.open("wb") as out:
        await asyncio.to_thread(shutil.copyfileobj, media.file, out, 1024 * 1024)
    if tmp.stat().st_size > MAX_ZIP_BYTES:
        tmp.unlink(missing_ok=True)
        raise ApiError(400, "The ZIP is larger than 1 GB. Split it into smaller uploads.")
    return tmp


@router.post("")
async def start_import(
    sheet: UploadFile = File(...),
    media: UploadFile | None = File(None),
    dryRun: bool = Form(False),
    user: CurrentUser = Depends(require_seller),
):
    rows = bulk_import.parse_sheet(await sheet.read(5 * 1024 * 1024))
    zip_path = await _save_zip(media) if media and media.filename else None
    try:
        source = bulk_import.MediaSource.from_zip(zip_path) if zip_path else bulk_import.MediaSource.empty()
    except Exception as e:  # noqa: BLE001 - corrupt or non-zip file
        if zip_path:
            zip_path.unlink(missing_ok=True)
        if isinstance(e, ApiError):
            raise
        raise ApiError(400, "That file is not a valid ZIP archive") from None

    if dryRun:
        try:
            results = await bulk_import.run_import(rows, source, user, dry_run=True)
        finally:
            source.close()
            if zip_path:
                zip_path.unlink(missing_ok=True)
        return {"dryRun": True, "total": len(rows), "ok": sum(r["status"] == "ok" for r in results), "results": results}

    db = get_db()
    job = {"sellerId": user.id, "status": "running", "total": len(rows), "done": 0, "results": [], "createdAt": datetime.now(UTC)}
    job_id = (await db.import_jobs.insert_one(job)).inserted_id

    async def progress(done: int, results: list[dict]) -> None:
        await db.import_jobs.update_one({"_id": job_id}, {"$set": {"done": done, "results": results}})

    async def work() -> None:
        try:
            results = await bulk_import.run_import(rows, source, user, progress=progress)
            created = sum(r["status"] == "created" for r in results)
            await db.import_jobs.update_one(
                {"_id": job_id}, {"$set": {"status": "finished", "created": created, "results": results, "finishedAt": datetime.now(UTC)}}
            )
        except Exception as e:  # noqa: BLE001 - record the failure for the seller instead of losing it
            await db.import_jobs.update_one({"_id": job_id}, {"$set": {"status": "failed", "error": str(e)[:300]}})
        finally:
            source.close()
            if zip_path:
                zip_path.unlink(missing_ok=True)

    task = asyncio.create_task(work())
    _running.add(task)
    task.add_done_callback(_running.discard)
    return {"jobId": str(job_id), "total": len(rows)}


@router.get("/{job_id}")
async def job_status(job_id: str, user: CurrentUser = Depends(require_seller)):
    oid = to_object_id(job_id)
    job = await get_db().import_jobs.find_one({"_id": oid}) if isinstance(oid, ObjectId) else None
    if not job or (job["sellerId"] != user.id and not user.is_admin):
        raise ApiError(404, "Import not found")
    job["id"] = str(job.pop("_id"))
    return job
