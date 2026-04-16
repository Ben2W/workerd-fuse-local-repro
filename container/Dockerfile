FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends fuse3 \
    && rm -rf /var/lib/apt/lists/*

COPY server.py /app/server.py
WORKDIR /app

EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]
