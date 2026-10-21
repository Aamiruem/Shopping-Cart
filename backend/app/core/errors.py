"""Every error leaves the API as {"error": "<message>"} - the shape the frontend expects."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("api")


class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers


def _validation_message(exc: RequestValidationError) -> str:
    err = exc.errors()[0]
    field = ".".join(str(p) for p in err["loc"] if p not in ("body", "query", "path"))
    if err["type"] == "json_invalid":
        return "Invalid JSON body"
    msg = err["msg"].removeprefix("Value error, ")
    return f"{field}: {msg}" if field else msg


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError):
        return JSONResponse({"error": exc.message}, status_code=exc.status, headers=exc.headers)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        unknown_route = exc.status_code == 404 and exc.detail == "Not Found"
        message = f"No route for {request.method} {request.url.path}" if unknown_route else exc.detail
        return JSONResponse({"error": message}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse({"error": _validation_message(exc)}, status_code=400)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse({"error": "Something went wrong. Please try again."}, status_code=500)
