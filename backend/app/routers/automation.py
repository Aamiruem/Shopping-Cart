"""/api/automation/run - for a scheduler (Amazon EventBridge, cron), protected by a shared key."""

import hmac

from fastapi import APIRouter, Header

from ..core.config import get_settings
from ..core.errors import ApiError
from ..services import automation

router = APIRouter(prefix="/api/automation", tags=["automation"], include_in_schema=False)


@router.post("/run")
async def run(x_automation_key: str = Header(default="")):
    key = get_settings().automation_key
    if not key:
        raise ApiError(404, "Not found")
    if not hmac.compare_digest(key, x_automation_key):
        raise ApiError(403, "Invalid key")
    return await automation.run_all()
