# Arvixa API (FastAPI) - production image
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_ENV=production

WORKDIR /app
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app ./app
COPY scripts ./scripts

# Run as an unprivileged user
RUN useradd --create-home --uid 10001 arvixa && mkdir -p /app/uploads && chown -R arvixa /app
USER arvixa

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*"]
