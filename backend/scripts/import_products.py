"""Bulk-import products from a CSV sheet + a folder of photos / videos (no upload size limits).

    python -m scripts.import_products --sheet products.csv --media path/to/photos --seller seller@shop.local
    python -m scripts.import_products --sheet products.csv --media path/to/photos --seller seller@shop.local --dry-run

Same sheet format as Seller Hub -> Products -> Bulk upload (download the template there, or see
app/services/bulk_import.py). Photos are optimised to WebP and stored in S3 (when S3_BUCKET is set) or uploads/.
"""

import argparse
import asyncio
import sys
from pathlib import Path

from app.core.errors import ApiError
from app.db.mongo import close_mongo, connect_mongo
from app.db.postgres import close_postgres, connect_postgres
from app.deps import CurrentUser
from app.services.bulk_import import MediaSource, parse_sheet, run_import


async def main(args) -> int:
    pool = await connect_postgres(run_schema=False)
    await connect_mongo()
    try:
        user = await pool.fetchrow("SELECT id, email, role FROM users WHERE email = $1", args.seller.lower())
        if not user or user["role"] not in ("seller", "admin"):
            print(f"No seller account for {args.seller}. Register the store in Seller Hub first.")
            return 1
        actor = CurrentUser(id=user["id"], email=user["email"], role=user["role"])
        try:
            rows = parse_sheet(Path(args.sheet).read_bytes())
        except ApiError as e:
            print(e.message)
            return 1
        media = MediaSource.from_folder(Path(args.media))
        print(f"{len(rows)} rows, {len(media.files)} media files in {args.media}{' (dry run)' if args.dry_run else ''}")

        async def progress(done: int, results: list[dict]) -> None:
            last = results[-1]
            print(
                f"  [{done}/{len(rows)}] row {last['row']}: {last['status']}{' - ' + last['error'] if last.get('error') else ''}",
                flush=True,
            )

        results = await run_import(rows, media, actor, dry_run=args.dry_run, progress=progress)
        good = sum(r["status"] in ("ok", "created") for r in results)
        print(f"Done: {good} {'valid' if args.dry_run else 'created'}, {len(results) - good} with errors")
        return 0 if good == len(results) else 2
    finally:
        await close_mongo()
        await close_postgres()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sheet", required=True, help="CSV file, one product per row")
    parser.add_argument("--media", required=True, help="folder with the photos / videos named in the sheet")
    parser.add_argument("--seller", required=True, help="email of the seller account that will own the products")
    parser.add_argument("--dry-run", action="store_true", help="check every row without creating anything")
    sys.exit(asyncio.run(main(parser.parse_args())))
