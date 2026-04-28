import uuid
import time
import secrets
import sqlite3
import hashlib
import hmac
from pathlib import Path
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import jwt
import fitz  # PyMuPDF
from fastapi import FastAPI, HTTPException, Header, UploadFile, File, Query, Request
from fastapi.responses import Response, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()

PROTECTED_DIR = Path(__file__).parent / "protected"
PROTECTED_DIR.mkdir(exist_ok=True)

JWT_SECRET = "change-me-in-production-" + secrets.token_hex(16)
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 72

# Shared secret between Prestashop and this app
PRESTASHOP_SECRET = "prestashop-shared-secret-change-me"

# Admin credentials (for upload/management only)
ADMIN_PASSWORD = "admin123"

GRID = 6

tile_tokens: dict[str, dict] = {}
books: dict[str, dict] = {}
DB_PATH = Path(__file__).parent / "drm.db"


# --- Database ---

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            display_name TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            page_count INTEGER NOT NULL,
            product_id TEXT,
            title TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS user_books (
            user_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            unlocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, book_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (book_id) REFERENCES books(id)
        );
        CREATE TABLE IF NOT EXISTS reading_progress (
            user_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            page INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, book_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (book_id) REFERENCES books(id)
        );
        CREATE INDEX IF NOT EXISTS idx_books_product_id ON books(product_id);
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    """)
    conn.commit()
    conn.close()


def get_or_create_user(email: str, display_name: str | None = None) -> str:
    conn = get_db()
    user = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if user:
        user_id = user["id"]
    else:
        user_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO users (id, email, display_name) VALUES (?,?,?)",
            (user_id, email, display_name or email.split("@")[0]),
        )
        conn.commit()
    conn.close()
    return user_id


SUPPORTED_EXTENSIONS = (".pdf", ".epub")


def scan_existing_pdfs():
    conn = get_db()
    for file_path in PROTECTED_DIR.iterdir():
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        book_id = str(uuid.uuid5(uuid.NAMESPACE_URL, file_path.name))
        existing = conn.execute("SELECT id FROM books WHERE id=?", (book_id,)).fetchone()
        doc = fitz.open(str(file_path))
        page_count = doc.page_count
        doc.close()
        if not existing:
            conn.execute(
                "INSERT INTO books (id, filename, path, page_count, title, product_id) VALUES (?,?,?,?,?,?)",
                (book_id, file_path.name, str(file_path), page_count, file_path.stem, file_path.stem),
            )
        books[book_id] = {"filename": file_path.name, "path": str(file_path), "page_count": page_count}

    for row in conn.execute("SELECT id, filename, path, page_count FROM books").fetchall():
        if row["id"] not in books and Path(row["path"]).exists():
            books[row["id"]] = {"filename": row["filename"], "path": row["path"], "page_count": row["page_count"]}

    conn.commit()
    conn.close()


init_db()
scan_existing_pdfs()


# --- Auth ---

def create_jwt_token(user_id: str, email: str, is_admin: bool = False) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "admin": is_admin,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Nicht eingeloggt")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {"user_id": payload["sub"], "email": payload["email"], "admin": payload.get("admin", False)}
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session abgelaufen")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Ungültige Session")


def require_admin(user: dict):
    if not user.get("admin"):
        raise HTTPException(403, "Admin-Zugriff erforderlich")


# --- Prestashop SSO Entry Point ---
# Prestashop generates a signed URL like:
#   https://reader.example.com/auth?email=user@example.com&name=Max&ts=1234567890&sig=HMAC_SHA256
#
# The reader validates the signature and creates a JWT session.

def verify_prestashop_signature(email: str, name: str, ts: str, sig: str) -> bool:
    # Link expires after 5 minutes
    try:
        timestamp = int(ts)
    except ValueError:
        return False
    if abs(time.time() - timestamp) > 300:
        return False

    # Verify HMAC
    message = f"{email}:{name}:{ts}"
    expected = hmac.new(PRESTASHOP_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


@app.get("/auth")
async def prestashop_auth(
    email: str = Query(...),
    name: str = Query(""),
    ts: str = Query(...),
    sig: str = Query(...),
    open_product: str | None = Query(None),
):
    """Entry point from Prestashop. Validates signed URL, creates session, redirects to reader."""
    if not verify_prestashop_signature(email, name, ts, sig):
        raise HTTPException(403, "Ungültiger oder abgelaufener Link")

    user_id = get_or_create_user(email, name)
    token = create_jwt_token(user_id, email)

    # Resolve product_id to book_id for direct open
    open_script = ""
    if open_product:
        conn = get_db()
        book = conn.execute("SELECT id FROM books WHERE product_id=?", (open_product,)).fetchone()
        conn.close()
        if book:
            open_script = f"sessionStorage.setItem('drm_open_book', '{book['id']}');"

    return HTMLResponse(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Anmeldung...</title></head>
<body><script>
    sessionStorage.setItem('drm_token', '{token}');
    sessionStorage.setItem('drm_email', '{email}');
    {open_script}
    window.location.href = '/';
</script></body></html>""")


# --- Admin login (only for book management, not for readers) ---

class AdminLoginRequest(BaseModel):
    password: str

@app.post("/api/admin/login")
async def admin_login(req: AdminLoginRequest):
    if req.password != ADMIN_PASSWORD:
        raise HTTPException(401, "Falsches Passwort")
    token = create_jwt_token("admin", "admin@local", is_admin=True)
    return {"token": token, "is_admin": True}


# --- Prestashop Webhook: unlock book on purchase ---

class WebhookPayload(BaseModel):
    secret: str
    email: str
    product_id: str
    name: str | None = None

@app.post("/api/webhook/prestashop")
async def prestashop_webhook(payload: WebhookPayload):
    if not hmac.compare_digest(payload.secret, PRESTASHOP_SECRET):
        raise HTTPException(403, "Invalid webhook secret")

    conn = get_db()
    book = conn.execute("SELECT id FROM books WHERE product_id=?", (payload.product_id,)).fetchone()
    if not book:
        conn.close()
        raise HTTPException(404, f"Kein Buch für product_id {payload.product_id}")
    book_id = book["id"]

    user_id = get_or_create_user(payload.email, payload.name)

    conn.execute("INSERT OR IGNORE INTO user_books (user_id, book_id) VALUES (?,?)", (user_id, book_id))
    conn.commit()
    conn.close()
    return {"status": "ok", "user_id": user_id, "book_id": book_id}


# --- Generate Prestashop link (helper for testing) ---

@app.get("/api/admin/generate-link")
async def generate_auth_link(
    email: str = Query(...),
    name: str = Query(""),
    authorization: str | None = Header(None),
):
    user = get_current_user(authorization)
    require_admin(user)
    ts = str(int(time.time()))
    message = f"{email}:{name}:{ts}"
    sig = hmac.new(PRESTASHOP_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()
    params = urlencode({"email": email, "name": name, "ts": ts, "sig": sig})
    return {"url": f"/auth?{params}"}


# --- Book endpoints ---

@app.post("/api/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    product_id: str | None = None,
    title: str | None = None,
    authorization: str | None = Header(None),
):
    user = get_current_user(authorization)
    require_admin(user)
    ext = Path(file.filename).suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(400, f"Nur {', '.join(SUPPORTED_EXTENSIONS)} erlaubt")
    book_id = str(uuid.uuid4())
    dest = PROTECTED_DIR / f"{book_id}{ext}"
    content = await file.read()
    dest.write_bytes(content)
    doc = fitz.open(str(dest))
    page_count = doc.page_count
    doc.close()

    conn = get_db()
    conn.execute(
        "INSERT INTO books (id, filename, path, page_count, product_id, title) VALUES (?,?,?,?,?,?)",
        (book_id, file.filename, str(dest), page_count, product_id, title or file.filename),
    )
    conn.commit()
    conn.close()

    books[book_id] = {"filename": file.filename, "path": str(dest), "page_count": page_count}
    return {"book_id": book_id, "filename": file.filename, "page_count": page_count}


@app.get("/api/books")
async def list_books(authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    conn = get_db()

    if user["admin"]:
        rows = conn.execute("SELECT id, filename, page_count, product_id, title FROM books").fetchall()
    else:
        rows = conn.execute("""
            SELECT b.id, b.filename, b.page_count, b.product_id, b.title
            FROM books b JOIN user_books ub ON b.id = ub.book_id
            WHERE ub.user_id = ?
        """, (user["user_id"],)).fetchall()

    result = []
    for r in rows:
        prog = conn.execute(
            "SELECT page FROM reading_progress WHERE user_id=? AND book_id=?",
            (user["user_id"], r["id"]),
        ).fetchone()
        result.append({
            "book_id": r["id"],
            "filename": r["filename"],
            "title": r["title"] or r["filename"],
            "page_count": r["page_count"],
            "product_id": r["product_id"],
            "current_page": prog["page"] if prog else 0,
        })

    conn.close()
    return result


@app.get("/api/book/{book_id}")
async def book_info(book_id: str, authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    if book_id not in books:
        raise HTTPException(404, "Buch nicht gefunden")
    if not user["admin"]:
        conn = get_db()
        access = conn.execute(
            "SELECT user_id FROM user_books WHERE user_id=? AND book_id=?",
            (user["user_id"], book_id),
        ).fetchone()
        conn.close()
        if not access:
            raise HTTPException(403, "Kein Zugriff")
    b = books[book_id]
    return {"book_id": book_id, "filename": b["filename"], "page_count": b["page_count"]}


# --- Reading Progress ---

class ProgressUpdate(BaseModel):
    page: int

@app.post("/api/book/{book_id}/progress")
async def save_progress(book_id: str, body: ProgressUpdate, authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    if book_id not in books:
        raise HTTPException(404)
    conn = get_db()
    conn.execute("""
        INSERT INTO reading_progress (user_id, book_id, page, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, book_id) DO UPDATE SET page=excluded.page, updated_at=CURRENT_TIMESTAMP
    """, (user["user_id"], book_id, body.page))
    conn.commit()
    conn.close()
    return {"status": "ok"}


@app.get("/api/book/{book_id}/progress")
async def get_progress(book_id: str, authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    conn = get_db()
    row = conn.execute(
        "SELECT page FROM reading_progress WHERE user_id=? AND book_id=?",
        (user["user_id"], book_id),
    ).fetchone()
    conn.close()
    return {"page": row["page"] if row else 0}


# --- Admin endpoints ---

class AssignBookRequest(BaseModel):
    email: str
    book_id: str

@app.post("/api/admin/assign-book")
async def assign_book(body: AssignBookRequest, authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    require_admin(user)
    user_id = get_or_create_user(body.email)
    if body.book_id not in books:
        raise HTTPException(404, "Buch nicht gefunden")
    conn = get_db()
    conn.execute("INSERT OR IGNORE INTO user_books (user_id, book_id) VALUES (?,?)", (user_id, body.book_id))
    conn.commit()
    conn.close()
    return {"status": "ok"}


class SetProductIdRequest(BaseModel):
    book_id: str
    product_id: str

@app.post("/api/admin/set-product-id")
async def set_product_id(body: SetProductIdRequest, authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    require_admin(user)
    if body.book_id not in books:
        raise HTTPException(404)
    conn = get_db()
    conn.execute("UPDATE books SET product_id=? WHERE id=?", (body.product_id, body.book_id))
    conn.commit()
    conn.close()
    return {"status": "ok"}


# --- Tile endpoints ---

@app.get("/api/book/{book_id}/page/{page}/tokens")
async def get_tile_tokens(book_id: str, page: int, authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    if not user["admin"]:
        conn = get_db()
        access = conn.execute(
            "SELECT user_id FROM user_books WHERE user_id=? AND book_id=?",
            (user["user_id"], book_id),
        ).fetchone()
        conn.close()
        if not access:
            raise HTTPException(403, "Kein Zugriff")
    if book_id not in books:
        raise HTTPException(404)
    if page < 0 or page >= books[book_id]["page_count"]:
        raise HTTPException(400, "Ungültige Seitenzahl")

    tokens = {}
    for row in range(GRID):
        for col in range(GRID):
            tok = secrets.token_urlsafe(32)
            tile_tokens[tok] = {
                "book_id": book_id, "page": page,
                "row": row, "col": col, "created": time.time(),
            }
            tokens[f"{row}_{col}"] = tok

    fakes = [secrets.token_urlsafe(32) for _ in range(10)]
    return {"tokens": tokens, "decoys": fakes}


@app.get("/api/book/{book_id}/page/{page}/tile/{row}/{col}")
async def get_tile(
    book_id: str, page: int, row: int, col: int,
    token: str = Query(...),
    authorization: str | None = Header(None),
):
    get_current_user(authorization)
    token_data = tile_tokens.pop(token, None)
    if not token_data:
        raise HTTPException(403, "Ungültiger Tile-Token")
    if (token_data["book_id"] != book_id or token_data["page"] != page
            or token_data["row"] != row or token_data["col"] != col):
        raise HTTPException(403, "Token stimmt nicht überein")
    if book_id not in books:
        raise HTTPException(404)

    doc = fitz.open(books[book_id]["path"])
    pg = doc.load_page(page)
    rect = pg.rect
    tw, th = rect.width / GRID, rect.height / GRID
    x0, y0 = col * tw, row * th
    x1 = (col + 1) * tw if col < GRID - 1 else rect.width
    y1 = (row + 1) * th if row < GRID - 1 else rect.height

    pix = pg.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=fitz.Rect(x0, y0, x1, y1))
    png_bytes = pix.tobytes("png")
    doc.close()

    return Response(content=png_bytes, media_type="image/png", headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache", "Expires": "0",
    })


@app.get("/api/decoy/{dummy_id}")
async def decoy(dummy_id: str, authorization: str | None = Header(None)):
    get_current_user(authorization)
    pixel = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
    return Response(content=pixel, media_type="image/png")


# --- Serve frontend ---
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

@app.get("/")
async def index():
    return HTMLResponse((FRONTEND_DIR / "index.html").read_text())

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# --- Security middleware ---
@app.middleware("http")
async def security_middleware(request, call_next):
    now = time.time()
    expired = [k for k, v in tile_tokens.items() if now - v["created"] > 300]
    for k in expired:
        tile_tokens.pop(k, None)
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' blob:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
    )
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "clipboard-write=(), clipboard-read=()"
    return response


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
