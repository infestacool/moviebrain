FROM python:3.12-slim

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY docker/entrypoint.sh /entrypoint.sh

# The entrypoint switches to PUID:PGID (default 99:100, Unraid's nobody:users).
# Set PUID/PGID to your user's IDs on QNAP or other Docker hosts.
ENV PYTHONUNBUFFERED=1 CONFIG_DIR=/config PUID=99 PGID=100
VOLUME /config
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz')"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
