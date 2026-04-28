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
import secrets
import time
from collections import OrderedDict
from typing import Any

import httpx
import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

CONVEX_URL = os.environ.get("CONVEX_URL", "").rstrip("/")
TILE_SERVICE_SECRET = os.environ.get("TILE_SERVICE_SECRET", "")
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()
]
GRID = 6
TILE_TOKEN_TTL = 300
PDF_CACHE_SIZE = 8
SESSION_CACHE_TTL = 60  # seconds — cache Convex session verify
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


async def convex_query(path: str, args: dict) -> Any:
    url = f"{CONVEX_URL}/api/query"
    r = await _client.post(url, json={"path": path, "args": args, "format": "json"})
    if r.status_code != 200:
        raise HTTPException(502, f"Convex query failed: {r.status_code} {r.text}")
    data = r.json()
    if data.get("status") != "success":
        raise HTTPException(403, f"Convex query error: {data.get('errorMessage', 'unknown')}")
    return data.get("value")


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
        meta = await convex_query(
            "books:getStoragePdfUrlForService",
            {"bookId": book_id, "serviceSecret": TILE_SERVICE_SECRET},
        )
        pdf_url = meta["url"]
        r = await _client.get(pdf_url)
        if r.status_code != 200:
            raise HTTPException(502, "Could not fetch PDF from storage")
        data = r.content
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
        result = await convex_query(
            "tileSessions:verify",
            {"sessionToken": x_tile_session, "serviceSecret": TILE_SERVICE_SECRET},
        )
        if not result or not result.get("ok"):
            raise HTTPException(
                401,
                f"Invalid session: {result.get('reason') if result else 'unknown'}",
            )
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
    meta = await convex_query(
        "books:getStoragePdfUrlForService",
        {"bookId": book_id, "serviceSecret": TILE_SERVICE_SECRET},
    )
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
    await require_session(x_tile_session, book_id)
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


@app.post("/api/inspect")
async def inspect(payload: dict):
    """Fetch file via signed URL and return page count + dimensions.
    Used by the admin page before createBook. The URL is already a
    short-lived signed Convex storage URL, so no extra auth needed here.
    """
    url = payload.get("url")
    if not url:
        raise HTTPException(400, "url missing")
    r = await _client.get(url)
    if r.status_code != 200:
        raise HTTPException(400, f"Fetch failed: {r.status_code}")
    data = r.content
    try:
        doc = fitz.open(stream=data, filetype=payload.get("filetype"))
    except Exception as e:
        raise HTTPException(400, f"Unsupported file: {e}")
    try:
        page_count = doc.page_count
        if page_count == 0:
            raise HTTPException(400, "File has 0 pages")
        pg = doc.load_page(0)
        pix = pg.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), alpha=False)
        w, h = pix.width, pix.height
        return {
            "pageCount": page_count,
            "width": w,
            "height": h,
        }
    finally:
        doc.close()


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
