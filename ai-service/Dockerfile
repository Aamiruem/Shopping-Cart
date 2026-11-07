FROM python:3.12-slim
WORKDIR /app

# docker build --build-arg DEEP_LEARNING=0 . gives a small image that uses the lighter fallbacks
ARG DEEP_LEARNING=1
COPY requirements.txt requirements-ml.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$DEEP_LEARNING" = "1" ]; then pip install --no-cache-dir -r requirements-ml.txt; fi
ENV DEEP_MODELS=$DEEP_LEARNING

COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
