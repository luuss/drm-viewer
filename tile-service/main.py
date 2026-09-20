"""Kachel-Gateway.

Der Browser bekommt nie die Druckdatei, sondern nur Ausschnitte der beim Import
gerenderten Seite — und auch die erst nach Pruefung der Lesesitzung.

Die Seitenbilder liegen im Medienspeicher (MinIO oder, ohne S3, in der
Convex-Ablage). Dieser Dienst haelt sie kurz im Arbeitsspeicher und schneidet
daraus die angefragte Kachel. Damit entfaellt das fruehere Rendern bei jedem
Aufruf, und PyMuPDF (AGPL) kommt hier gar nicht mehr vor.
"""

from __future__ import annotations

import asyncio
import hmac
import io
import os
import time
from collections import OrderedDict, defaultdict, deque
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image

CONVEX_SITE_URL = os.environ.get("CONVEX_SITE_URL", "").rstrip("/")
if not CONVEX_SITE_URL:
    CONVEX_SITE_URL = (
        os.environ.get("CONVEX_URL", "").rstrip("/").replace(".convex.cloud", ".convex.site")
    )
TILE_SERVICE_SECRET = os.environ.get("TILE_SERVICE_SECRET", "")
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
    if o.strip()
]

TILE_SIZE = int(os.environ.get("TILE_SIZE", "512"))
PAGE_CACHE = int(os.environ.get("PAGE_CACHE", "24"))
SESSION_CACHE_TTL = 60
USAGE_FLUSH_SECONDS = int(os.environ.get("USAGE_FLUSH_SECONDS", "30"))
MAX_PAGES_PER_MIN = int(os.environ.get("MAX_PAGES_PER_MIN", "80"))
MAX_TILES_PER_MIN = int(os.environ.get("MAX_TILES_PER_MIN", "1200"))

if not CONVEX_SITE_URL or not TILE_SERVICE_SECRET:
    raise RuntimeError("CONVEX_SITE_URL und TILE_SERVICE_SECRET muessen gesetzt sein")

app = FastAPI(title="Kachel-Gateway", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_client = httpx.AsyncClient(timeout=60.0, follow_redirects=False)
_page_cache: "OrderedDict[str, Image.Image]" = OrderedDict()
_page_meta: dict[str, dict] = {}
_session_cache: dict[str, tuple[float, dict]] = {}
_rate: dict[str, deque[float]] = defaultdict(deque)
_usage: dict[str, int] = defaultdict(int)
_lock = asyncio.Lock()


async def service_call(path: str, body: dict) -> Any:
    res = await _client.post(
        f"{CONVEX_SITE_URL}{path}",
        json=body,
        headers={"x-service-secret": TILE_SERVICE_SECRET},
    )
    if res.status_code != 200:
        print(f"Dienstaufruf {path}: {res.status_code} {res.text[:200]}")
        raise HTTPException(502, "Backend nicht erreichbar")
    return res.json()


def check_rate(key: str, limit: int, what: str) -> None:
    now = time.time()
    hits = _rate[key]
    while hits and now - hits[0] > 60:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(429, f"Zu viele {what} pro Minute")
    hits.append(now)


async def require_session(token: str | None, issue_id: str | None = None) -> dict:
    if not token:
        raise HTTPException(401, "Keine Lesesitzung")
    now = time.time()
    cached = _session_cache.get(token)
    if cached and cached[0] > now:
        session = cached[1]
    else:
        session = await service_call("/service/session/verify", {"sessionToken": token})
        if not session or not session.get("ok"):
            print(f"Sitzung abgelehnt: {session.get('reason') if session else '?'}")
            raise HTTPException(401, "Sitzung ungueltig")
        _session_cache[token] = (now + SESSION_CACHE_TTL, session)
        if len(_session_cache) > 512:
            for k, (exp, _) in list(_session_cache.items()):
                if exp < now:
                    _session_cache.pop(k, None)
    if issue_id and session.get("issueId") != issue_id:
        raise HTTPException(403, "Sitzung gilt fuer eine andere Ausgabe")
    return session


async def load_page(issue_id: str, index: int) -> tuple[Image.Image, dict]:
    key = f"{issue_id}:{index}"
    async with _lock:
        if key in _page_cache:
            _page_cache.move_to_end(key)
            return _page_cache[key], _page_meta[key]

    info = await service_call(
        "/service/page/resolve", {"issueId": issue_id, "index": index}
    )
    if not info or not info.get("ready"):
        raise HTTPException(409, "Seite ist noch nicht aufbereitet")
    url = info.get("url")
    if not url:
        raise HTTPException(409, "Seitenbild nicht abrufbar")

    res = await _client.get(url, timeout=120.0)
    if res.status_code != 200:
        raise HTTPException(502, "Seitenbild nicht ladbar")
    image = Image.open(io.BytesIO(res.content)).convert("RGB")
    meta = {"width": image.width, "height": image.height}
    async with _lock:
        _page_cache[key] = image
        _page_meta[key] = meta
        while len(_page_cache) > PAGE_CACHE:
            old, _ = _page_cache.popitem(last=False)
            _page_meta.pop(old, None)
    return image, meta


async def flush_usage() -> None:
    """Verbrauch gesammelt melden, nicht bei jeder Kachel."""
    while True:
        await asyncio.sleep(USAGE_FLUSH_SECONDS)
        pending = {k: v for k, v in _usage.items() if v > 0}
        _usage.clear()
        for token, tiles in pending.items():
            try:
                await service_call(
                    "/service/session/usage", {"sessionToken": token, "tiles": tiles}
                )
            except Exception as exc:
                print(f"Verbrauchsmeldung fehlgeschlagen: {exc}")


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(flush_usage())


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": "tiles", "cachedPages": len(_page_cache)}


@app.get("/api/session")
async def session_info(
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> dict:
    session = await require_session(x_tile_session)
    return {
        "issueId": session["issueId"],
        # Kurzkennung fuers Wasserzeichen im Reader.
        "watermark": session.get("watermark", ""),
    }


@app.get("/api/issue/{issue_id}/page/{index}/info")
async def page_info(
    issue_id: str,
    index: int,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> dict:
    session = await require_session(x_tile_session, issue_id)
    check_rate(f'{session.get("userId")}:{issue_id}', MAX_PAGES_PER_MIN, "Seiten")
    _, meta = await load_page(issue_id, index)
    levels = 1
    while max(meta["width"], meta["height"]) >> levels > TILE_SIZE:
        levels += 1
    return {
        "width": meta["width"],
        "height": meta["height"],
        "tileSize": TILE_SIZE,
        "maxLevel": levels,
    }


@app.get("/api/issue/{issue_id}/page/{index}/tile/{level}/{col}/{row}.jpg")
async def tile(
    issue_id: str,
    index: int,
    level: int,
    col: int,
    row: int,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> Response:
    session = await require_session(x_tile_session, issue_id)
    check_rate(f'{session.get("userId")}:{issue_id}', MAX_TILES_PER_MIN, "Kacheln")
    _usage[x_tile_session or ""] += 1

    image, meta = await load_page(issue_id, index)
    scale = 2 ** max(0, level)
    width = max(1, meta["width"] // scale)
    height = max(1, meta["height"] // scale)
    left = col * TILE_SIZE
    top = row * TILE_SIZE
    if left >= width or top >= height or level < 0 or level > 12:
        raise HTTPException(404, "Kachel ausserhalb der Seite")

    box = (
        left * scale,
        top * scale,
        min(meta["width"], (left + TILE_SIZE) * scale),
        min(meta["height"], (top + TILE_SIZE) * scale),
    )
    cropped = image.crop(box)
    target = (
        max(1, (box[2] - box[0]) // scale),
        max(1, (box[3] - box[1]) // scale),
    )
    if cropped.size != target:
        cropped = cropped.resize(target, Image.LANCZOS)

    buf = io.BytesIO()
    cropped.save(buf, format="JPEG", quality=82, optimize=True)
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        # Unveraenderlich, aber nur hinter der Sitzung erreichbar.
        headers={"Cache-Control": "private, max-age=600"},
    )


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    return response
