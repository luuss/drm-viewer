"""
Stateless tile renderer. No DB. Trust Convex for auth + book metadata.

Flow:
  1. Client calls Convex mutation `tileSessions.issue({bookId})` → gets session token.
  2. Client hits this service with header `X-Tile-Session: <token>`.
  3. Service verifies token via Convex query `tileSessions.verify`.
  4. Service fetches PDF storage URL via Convex query `books.getStoragePdfUrlForService`.
  5. Service caches PDF bytes in-memory (LRU).
  6. Tiles rendered on-the-fly with per-session randomization (jitter, watermark).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import random
import hashlib
import hmac
import secrets
import time
from collections import OrderedDict, defaultdict, deque
from typing import Any

import httpx
import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

CONVEX_URL = os.environ.get("CONVEX_URL", "").rstrip("/")
# HTTP-Endpunkte liegen bei Convex auf einer eigenen Adresse (.convex.site).
CONVEX_SITE_URL = os.environ.get(
    "CONVEX_SITE_URL", CONVEX_URL.replace(".convex.cloud", ".convex.site")
).rstrip("/")
MAX_SOURCE_BYTES = int(os.environ.get("MAX_SOURCE_BYTES", 400 * 1024 * 1024))
TILE_SERVICE_SECRET = os.environ.get("TILE_SERVICE_SECRET", "")
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()
]
GRID = 6
TILE_TOKEN_TTL = 300
PDF_CACHE_SIZE = 8
SESSION_CACHE_TTL = 60  # seconds — cache Convex session verify
# Missbrauchsbremse: ein Mensch blaettert, ein Skript saugt.
MAX_PAGES_PER_MIN = int(os.environ.get("MAX_PAGES_PER_MIN", "40"))
MAX_TILES_PER_MIN = int(os.environ.get("MAX_TILES_PER_MIN", "900"))
USAGE_FLUSH_SECONDS = int(os.environ.get("USAGE_FLUSH_SECONDS", "30"))
PAGE_PIXMAP_CACHE = 40  # rendered full-page pixmaps across books

if not CONVEX_URL:
    raise RuntimeError("CONVEX_URL env not set")
if not TILE_SERVICE_SECRET:
    raise RuntimeError("TILE_SERVICE_SECRET env not set")

app = FastAPI(title="DRM Tile Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# --- Convex HTTP client ---

_client = httpx.AsyncClient(timeout=30.0)


async def service_call(path: str, body: dict) -> Any:
    """Ruft einen geschuetzten Dienst-Endpunkt in Convex auf.

    Das Geheimnis steht im Header, nicht im Argument. Die zugehoerigen
    Convex-Funktionen sind intern, also nicht oeffentlich aufrufbar.
    """
    url = f"{CONVEX_SITE_URL}{path}"
    r = await _client.post(
        url, json=body, headers={"x-service-secret": TILE_SERVICE_SECRET}
    )
    if r.status_code != 200:
        # Fehlertext bleibt im Log, nicht in der Antwort an den Browser.
        print(f"Dienstaufruf {path} fehlgeschlagen: {r.status_code} {r.text[:200]}")
        raise HTTPException(502, "Backend nicht erreichbar")
    return r.json()


# --- Rate limiting and usage reporting ---

_rate_pages: dict[str, deque[float]] = defaultdict(deque)
_rate_tiles: dict[str, deque[float]] = defaultdict(deque)
_usage_pending: dict[str, int] = defaultdict(int)


def _check_rate(bucket: dict[str, deque[float]], key: str, limit: int, what: str) -> None:
    now = time.time()
    hits = bucket[key]
    while hits and now - hits[0] > 60:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(429, f"Zu viele {what} pro Minute")
    hits.append(now)


async def _flush_usage_loop() -> None:
    """Verbrauch gesammelt an Convex melden, nicht bei jeder Kachel."""
    while True:
        await asyncio.sleep(USAGE_FLUSH_SECONDS)
        pending = {k: v for k, v in _usage_pending.items() if v > 0}
        _usage_pending.clear()
        for token, tiles in pending.items():
            try:
                await service_call(
                    "/service/session/usage",
                    {"sessionToken": token, "tiles": tiles},
                )
            except Exception as exc:
                print(f"Verbrauchsmeldung fehlgeschlagen: {exc}")


@app.on_event("startup")
async def _start_usage_reporter() -> None:
    asyncio.create_task(_flush_usage_loop())


# Grosse Hefte brauchen Minuten, nicht Sekunden. Der Standard-Zeitrahmen des
# Clients gilt fuer kurze Dienstaufrufe.
BIG_FILE_TIMEOUT = httpx.Timeout(900.0, connect=15.0)


async def _download_limited(url: str) -> bytes:
    """Laedt eine Datei mit hartem Groessendeckel und ohne Weiterleitungen."""
    chunks: list[bytes] = []
    size = 0
    async with _client.stream(
        "GET", url, follow_redirects=False, timeout=BIG_FILE_TIMEOUT
    ) as res:
        if res.status_code != 200:
            print(f"Download fehlgeschlagen: {res.status_code} {url[:80]}")
            raise HTTPException(502, "Datei nicht ladbar")
        async for chunk in res.aiter_bytes():
            size += len(chunk)
            if size > MAX_SOURCE_BYTES:
                raise HTTPException(413, "Datei zu gross")
            chunks.append(chunk)
    return b"".join(chunks)


# --- PDF cache ---

class PdfCache:
    def __init__(self, size: int):
        self.size = size
        self._items: OrderedDict[str, bytes] = OrderedDict()
        self._lock = asyncio.Lock()

    async def fetch(self, book_id: str) -> bytes:
        async with self._lock:
            if book_id in self._items:
                self._items.move_to_end(book_id)
                return self._items[book_id]
        meta = await service_call("/service/book/pdf-url", {"bookId": book_id})
        pdf_url = meta["url"]
        data = await _download_limited(pdf_url)
        async with self._lock:
            self._items[book_id] = data
            if len(self._items) > self.size:
                self._items.popitem(last=False)
        return data


pdf_cache = PdfCache(PDF_CACHE_SIZE)


class PagePixmapCache:
    """Caches full-page rendered bytes (RGB samples + dims) per (book, page)."""

    def __init__(self, size: int):
        self.size = size
        self._items: OrderedDict[tuple[str, int], tuple[int, int, bytes]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, book_id: str, page: int, pdf_bytes: bytes) -> tuple[int, int, bytes]:
        key = (book_id, page)
        async with self._lock:
            if key in self._items:
                self._items.move_to_end(key)
                return self._items[key]

        data = await asyncio.to_thread(_render_full_page, pdf_bytes, page)
        async with self._lock:
            self._items[key] = data
            if len(self._items) > self.size:
                self._items.popitem(last=False)
        return data


page_pixmap_cache = PagePixmapCache(PAGE_PIXMAP_CACHE)


def _render_full_page(pdf_bytes: bytes, page: int) -> tuple[int, int, bytes]:
    """Render full page once, return (width, height, RGB samples)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        pg = doc.load_page(page)
        pix = pg.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
        return pix.width, pix.height, bytes(pix.samples_mv)
    finally:
        doc.close()


# --- Session verify ---

_session_cache: dict[str, tuple[float, dict]] = {}
_session_lock = asyncio.Lock()


async def require_session(
    x_tile_session: str | None,
    book_id: str | None = None,
) -> dict:
    if not x_tile_session:
        raise HTTPException(401, "Missing X-Tile-Session")

    now = time.time()
    async with _session_lock:
        cached = _session_cache.get(x_tile_session)
        if cached and cached[0] > now:
            result = cached[1]
        else:
            result = None

    if result is None:
        result = await service_call(
            "/service/session/verify", {"sessionToken": x_tile_session}
        )
        if not result or not result.get("ok"):
            print(f"Sitzung abgelehnt: {result.get('reason') if result else 'unbekannt'}")
            raise HTTPException(401, "Sitzung ungueltig")
        async with _session_lock:
            _session_cache[x_tile_session] = (now + SESSION_CACHE_TTL, result)
            # GC old
            if len(_session_cache) > 256:
                for k in [k for k, (exp, _) in _session_cache.items() if exp < now]:
                    _session_cache.pop(k, None)

    if book_id and result.get("bookId") != book_id:
        raise HTTPException(403, "Session not valid for this book")
    return result


# --- Tile tokens (one-time, in-memory, process-local) ---

_tile_tokens: dict[str, dict] = {}


def _gc_tokens() -> None:
    now = time.time()
    expired = [k for k, v in _tile_tokens.items() if now - v["created"] > TILE_TOKEN_TTL]
    for k in expired:
        _tile_tokens.pop(k, None)


# --- Book metadata cache ---

_book_meta: dict[str, dict] = {}


async def get_book_meta(book_id: str) -> dict:
    if book_id in _book_meta:
        return _book_meta[book_id]
    meta = await service_call("/service/book/pdf-url", {"bookId": book_id})
    info = {"pageCount": int(meta["pageCount"]), "filename": meta.get("filename") or ""}
    _book_meta[book_id] = info
    return info


# --- On-the-fly variance per tile request ---

def _variance_seed(session_token: str, book_id: str, page: int, row: int, col: int) -> int:
    h = hashlib.sha256(
        f"{session_token}:{book_id}:{page}:{row}:{col}:{secrets.token_hex(8)}".encode()
    ).digest()
    return int.from_bytes(h[:8], "big")


# --- Routes ---

@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/book/{book_id}/page/{page}/tokens")
async def get_tile_tokens(
    book_id: str,
    page: int,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
):
    _gc_tokens()
    session = await require_session(x_tile_session, book_id)
    _check_rate(
        _rate_pages,
        f'{session.get("userId", "?")}:{book_id}',
        MAX_PAGES_PER_MIN,
        "Seiten",
    )
    meta = await get_book_meta(book_id)
    if page < 0 or page >= meta["pageCount"]:
        raise HTTPException(400, "Invalid page")

    tokens: dict[str, str] = {}
    for r in range(GRID):
        for c in range(GRID):
            tok = secrets.token_urlsafe(32)
            _tile_tokens[tok] = {
                "book_id": book_id,
                "page": page,
                "row": r,
                "col": c,
                "session": x_tile_session,
                "created": time.time(),
            }
            tokens[f"{r}_{c}"] = tok

    decoys = [secrets.token_urlsafe(32) for _ in range(10)]

    pdf_bytes = await pdf_cache.fetch(book_id)
    asyncio.create_task(_prefetch_page(book_id, page, pdf_bytes))
    for ahead in (1, 2, 3):
        if page + ahead < meta["pageCount"]:
            asyncio.create_task(_prefetch_page(book_id, page + ahead, pdf_bytes))
    if page - 1 >= 0:
        asyncio.create_task(_prefetch_page(book_id, page - 1, pdf_bytes))

    return {"tokens": tokens, "decoys": decoys, "pageCount": meta["pageCount"]}


async def _prefetch_page(book_id: str, page: int, pdf_bytes: bytes) -> None:
    try:
        await page_pixmap_cache.get(book_id, page, pdf_bytes)
    except Exception:
        pass


@app.get("/api/book/{book_id}/page/{page}/tile/{row}/{col}")
async def get_tile(
    book_id: str,
    page: int,
    row: int,
    col: int,
    token: str = Query(...),
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
):
    session = await require_session(x_tile_session, book_id)
    _check_rate(
        _rate_tiles,
        f'{session.get("userId", "?")}:{book_id}',
        MAX_TILES_PER_MIN,
        "Kacheln",
    )
    _usage_pending[x_tile_session or ""] += 1
    tok = _tile_tokens.pop(token, None)
    if not tok:
        raise HTTPException(403, "Invalid tile token")
    if (
        tok["book_id"] != book_id
        or tok["page"] != page
        or tok["row"] != row
        or tok["col"] != col
        or tok["session"] != x_tile_session
    ):
        raise HTTPException(403, "Tile token mismatch")

    pdf_bytes = await pdf_cache.fetch(book_id)
    w, h, samples = await page_pixmap_cache.get(book_id, page, pdf_bytes)
    png = await asyncio.to_thread(
        _slice_tile,
        w,
        h,
        samples,
        row,
        col,
        x_tile_session or "",
        book_id,
        page,
    )
    return Response(
        content=png,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


def _slice_tile(
    full_w: int,
    full_h: int,
    full_samples: bytes,
    row: int,
    col: int,
    session_token: str,
    book_id: str,
    page: int,
) -> bytes:
    """Slice tile from already-rendered full-page RGB samples.
    Apply per-request watermark (still unique per render) for DRM variance.
    """
    tile_w = full_w // GRID
    tile_h = full_h // GRID
    x0 = col * tile_w
    y0 = row * tile_h
    # Last col/row gets the remainder to avoid losing pixels.
    x1 = full_w if col == GRID - 1 else (col + 1) * tile_w
    y1 = full_h if row == GRID - 1 else (row + 1) * tile_h
    w = x1 - x0
    h = y1 - y0

    # Copy the tile region (3 bytes per px, full-row stride = full_w * 3).
    stride = full_w * 3
    out = bytearray(w * h * 3)
    dst = 0
    src_row = y0 * stride + x0 * 3
    row_bytes = w * 3
    for _ in range(h):
        out[dst : dst + row_bytes] = full_samples[src_row : src_row + row_bytes]
        dst += row_bytes
        src_row += stride

    # Per-request watermark.
    seed = _variance_seed(session_token, book_id, page, row, col)
    rng = random.Random(seed)
    n = len(out)
    for _ in range(24):
        idx = rng.randrange(n)
        out[idx] = max(0, min(255, out[idx] + (1 if rng.random() > 0.5 else -1)))

    pix = fitz.Pixmap(fitz.csRGB, w, h, bytes(out), 0)
    return pix.tobytes("jpeg", jpg_quality=88)


def _verify_prepare_ticket(payload: dict) -> tuple[list[str], str, str, str, str]:
    """Prueft den von Convex unterschriebenen Auftrag und gibt die Teile zurueck."""
    sources = payload.get("sources") or []
    merged_upload = payload.get("mergedUploadUrl") or ""
    cover_upload = payload.get("coverImageUploadUrl") or ""
    filetype = payload.get("filetype")
    cover_order = payload.get("coverOrder") or "print"
    ticket = payload.get("ticket")
    expires_at = payload.get("expiresAt")

    if not sources or filetype not in ("pdf", "epub") or not ticket:
        raise HTTPException(400, "Unvollstaendiger Auftrag")
    try:
        expires_at = int(expires_at)
    except (TypeError, ValueError):
        raise HTTPException(400, "Unvollstaendiger Auftrag")
    if expires_at < time.time() * 1000:
        raise HTTPException(403, "Auftrag abgelaufen")

    signed = "~".join(
        [
            "|".join(sources),
            merged_upload,
            cover_upload,
            filetype,
            cover_order,
            str(expires_at),
        ]
    )
    expected = hmac.new(
        TILE_SERVICE_SECRET.encode(), signed.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, str(ticket)):
        raise HTTPException(403, "Auftrag nicht gueltig")
    return sources, merged_upload, cover_upload, filetype, cover_order


async def _upload_to_storage(upload_url: str, data: bytes, content_type: str) -> str:
    r = await _client.post(
        upload_url,
        content=data,
        headers={"Content-Type": content_type},
        timeout=BIG_FILE_TIMEOUT,
    )
    if r.status_code != 200:
        print(f"Upload fehlgeschlagen: {r.status_code} {r.text[:200]}")
        raise HTTPException(502, "Upload in den Speicher fehlgeschlagen")
    return r.json()["storageId"]


def _merge_documents(parts: list[bytes], filetype: str, cover_order: str) -> bytes:
    """Umschlag und Innenteil zu einer Lesefassung zusammenfuegen.

    Ein Umschlag kommt aus der Druckvorstufe in Bogenreihenfolge: die Datei
    beginnt mit der Rueckseite (U4), dann folgt der Titel (U1), danach die
    beiden Innenseiten U2 und U3. So gebunden faengt das Heft mit der
    Rueckseite an. Fuer den Leser wird daraus U1, U2, Innenteil, U3, U4.
    """
    out = fitz.open()
    try:
        if len(parts) == 1:
            src = fitz.open(stream=parts[0], filetype=filetype)
            try:
                out.insert_pdf(src)
            finally:
                src.close()
            return out.tobytes(garbage=3, deflate=True)

        cover = fitz.open(stream=parts[0], filetype=filetype)
        inner = fitz.open(stream=parts[1], filetype=filetype)
        try:
            n = cover.page_count
            if cover_order == "print" and n == 4:
                # Bogenreihenfolge U4, U1, U2, U3 -> Lesereihenfolge.
                out.insert_pdf(cover, from_page=1, to_page=2)   # U1, U2
                out.insert_pdf(inner)
                out.insert_pdf(cover, from_page=3, to_page=3)   # U3
                out.insert_pdf(cover, from_page=0, to_page=0)   # U4
            elif cover_order == "print" and n == 2:
                # Nur Titel und Rueckseite: Rueckseite steht vorn.
                out.insert_pdf(cover, from_page=1, to_page=1)
                out.insert_pdf(inner)
                out.insert_pdf(cover, from_page=0, to_page=0)
            else:
                out.insert_pdf(cover)
                out.insert_pdf(inner)
            return out.tobytes(garbage=3, deflate=True)
        finally:
            cover.close()
            inner.close()
    finally:
        out.close()


def _render_cover(data: bytes, filetype: str) -> tuple[bytes, int, int, int]:
    """Erste Seite als Titelbild rendern und Seitenmass ermitteln."""
    doc = fitz.open(stream=data, filetype=filetype)
    try:
        if doc.page_count == 0:
            raise HTTPException(400, "Datei hat keine Seiten")
        page = doc.load_page(0)
        pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
        cover = page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False)
        return cover.tobytes("jpeg", jpg_quality=82), doc.page_count, pix.width, pix.height
    finally:
        doc.close()


@app.post("/api/prepare")
async def prepare(payload: dict):
    """Neue Ausgabe aufbereiten: zusammenfuegen, vermessen, Titelbild rendern.

    Aufruf aus der Redaktionsoberflaeche. Quellen und Ablageziele stehen im
    unterschriebenen Auftrag, der Dienst waehlt sie nicht selbst.
    """
    sources, merged_upload, cover_upload, filetype, cover_order = _verify_prepare_ticket(
        payload
    )

    parts = [await _download_limited(u) for u in sources]
    merged_storage_id: str | None = None

    if len(parts) > 1:
        if not merged_upload:
            raise HTTPException(400, "Ziel fuer die zusammengefuegte Datei fehlt")
        data = await asyncio.to_thread(_merge_documents, parts, filetype, cover_order)
        merged_storage_id = await _upload_to_storage(
            merged_upload, data, "application/pdf"
        )
    else:
        data = parts[0]

    cover_jpeg, page_count, width, height = await asyncio.to_thread(
        _render_cover, data, filetype
    )
    cover_storage_id = await _upload_to_storage(cover_upload, cover_jpeg, "image/jpeg")

    return {
        "pageCount": page_count,
        "width": width,
        "height": height,
        "mergedStorageId": merged_storage_id,
        "coverStorageId": cover_storage_id,
    }


@app.get("/api/decoy/{dummy_id}")
async def decoy(
    dummy_id: str,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
):
    await require_session(x_tile_session)
    pixel = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
        b"\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    return Response(content=pixel, media_type="image/png")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
