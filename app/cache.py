"""Fetched facts, kept in memory and, for long-lived ones, on disk in /config/cache.

The disk copy means restarts and container updates don't refetch everything from
IMDb and Wikipedia, which keeps requests to them (and the chance of being blocked) down.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time

from . import config

log = logging.getLogger(__name__)

DEFAULT_TTL = config.CACHE_HOURS * 3600
MEMORY_MAX = 5000  # entries; anyone who can open the page can trigger lookups
DISK_DIR = config.CONFIG_DIR / "cache"
DISK_MAX_BYTES = float(os.environ.get("CACHE_MAX_MB", "200")) * 1024 * 1024
PRUNE_EVERY = 100  # disk writes between clean-ups

_memory: dict[str, tuple[float, object]] = {}
_writes = 0
_disk_ok = True


def _path(key: str):
    return DISK_DIR / (hashlib.sha256(key.encode()).hexdigest()[:32] + ".json")


def _remember(key: str, expires: float, value) -> None:
    if len(_memory) >= MEMORY_MAX:
        now = time.time()
        for k in [k for k, (exp, _) in _memory.items() if exp <= now]:
            del _memory[k]
        while len(_memory) >= MEMORY_MAX:  # still full: drop the oldest entries
            del _memory[next(iter(_memory))]
    _memory[key] = (expires, value)


def get(key: str):
    """The cached value, or None if it's missing or expired."""
    now = time.time()
    hit = _memory.get(key)
    if hit and hit[0] > now:
        return hit[1]
    try:
        data = json.loads(_path(key).read_text())
    except (OSError, ValueError):
        return None
    if data.get("key") != key or data.get("expires", 0) <= now:
        return None
    _remember(key, data["expires"], data["value"])
    return data["value"]


def put(key: str, value, ttl: float | None = None):
    """Cache a value. Only entries with the default (long) lifetime are written to disk."""
    expires = time.time() + (ttl if ttl is not None else DEFAULT_TTL)
    _remember(key, expires, value)
    if ttl is None:
        _write(key, expires, value)
    return value


def _write(key: str, expires: float, value) -> None:
    global _writes, _disk_ok
    if not _disk_ok:
        return
    try:
        DISK_DIR.mkdir(parents=True, exist_ok=True)
        path = _path(key)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"key": key, "expires": expires, "value": value}))
        tmp.replace(path)
    except (OSError, TypeError, ValueError) as e:
        if isinstance(e, OSError):
            _disk_ok = False  # e.g. a read-only /config: carry on with memory only
        log.warning("Couldn't save to the disk cache: %s", e)
        return
    _writes += 1
    if _writes % PRUNE_EVERY == 1:
        prune()


def prune() -> None:
    """Delete expired files, then the oldest ones while the cache is over its size limit."""
    try:
        files = [(f, f.stat()) for f in DISK_DIR.glob("*.json")]
    except OSError:
        return
    now = time.time()
    kept = []
    for f, st in files:
        # Every file on disk was written with DEFAULT_TTL, so its age tells whether it has expired.
        if st.st_mtime + DEFAULT_TTL <= now:
            f.unlink(missing_ok=True)
        else:
            kept.append((f, st))
    total = sum(st.st_size for _, st in kept)
    for f, st in sorted(kept, key=lambda x: x[1].st_mtime):
        if total <= DISK_MAX_BYTES:
            break
        f.unlink(missing_ok=True)
        total -= st.st_size


def stats() -> dict:
    try:
        sizes = [f.stat().st_size for f in DISK_DIR.glob("*.json")]
    except OSError:
        sizes = []
    return {"entries": len(sizes), "bytes": sum(sizes), "max_bytes": int(DISK_MAX_BYTES), "days": DEFAULT_TTL / 86400}


def clear() -> None:
    _memory.clear()
    for f in DISK_DIR.glob("*.json"):
        f.unlink(missing_ok=True)
