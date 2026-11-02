FROM python:3.12-slim

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

# Unraid's appdata is owned by nobody:users (99:100), so run as that.
RUN mkdir -p /config && chown 99:100 /config
VOLUME /config
ENV PYTHONUNBUFFERED=1 CONFIG_DIR=/config
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"
USER 99:100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
