FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# docker build --build-arg DEEP_LEARNING=0 . gives a small image that uses the lighter fallbacks
ARG DEEP_LEARNING=1
COPY requirements.txt requirements-ml.txt ./
RUN pip install --no-cache-dir -r requirements.txt     && if [ "$DEEP_LEARNING" = "1" ]; then pip install --no-cache-dir -r requirements-ml.txt; fi
ENV DEEP_MODELS=$DEEP_LEARNING

COPY . .
# The unit tests need no database or API key, so a broken build never ships
RUN python -m pytest -q -p no:cacheprovider

# Run as an unprivileged user
RUN useradd --create-home --uid 10001 app && chown -R app /app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
