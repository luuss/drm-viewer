"""Extraktionsdienst: Druck-PDF oder IDML in Artikel zerlegen.

Der Dienst nimmt einen Auftrag an, laedt die Quelldatei ueber eine signierte
URL, zerlegt sie und meldet das Ergebnis an Convex zurueck. Die Arbeit laeuft im
Hintergrund, weil ein Heft mehrere Minuten braucht.
"""

from __future__ import annotations

import hmac
import os
import tempfile
import traceback
from typing import Any

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from extractor.idml_extract import extract_idml
from extractor.pdf_extract import extract_pdf

# Eigenes Geheimnis; faellt auf das des Kacheldienstes zurueck, damit
# bestehende Installationen ohne Aenderung weiterlaufen.
SERVICE_SECRET = os.environ.get("EXTRACT_SERVICE_SECRET") or os.environ.get(
    "TILE_SERVICE_SECRET", ""
)
# Rueckmeldungen gehen nur an das eigene Backend, nie an eine beliebige Adresse.
CONVEX_SITE_URL = os.environ.get("CONVEX_SITE_URL", "").rstrip("/")
MAX_SOURCE_BYTES = int(os.environ.get("MAX_SOURCE_BYTES", 400 * 1024 * 1024))
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
    if o.strip()
]

app = FastAPI(title="Artikel-Extraktion", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# Keine Weiterleitungen: sonst laesst sich der Dienst ueber einen Redirect auf
# interne Adressen lenken.
_client = httpx.AsyncClient(timeout=120.0, follow_redirects=False)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "extract"}


async def _download(url: str, suffix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    size = 0
    async with _client.stream("GET", url) as res:
        if res.status_code != 200:
            raise HTTPException(502, f"Quelle nicht ladbar: {res.status_code}")
        with open(path, "wb") as fh:
            async for chunk in res.aiter_bytes():
                size += len(chunk)
                if size > MAX_SOURCE_BYTES:
                    raise HTTPException(413, "Quelldatei zu gross")
                fh.write(chunk)
    return path


def _callback_allowed(url: str) -> bool:
    if not CONVEX_SITE_URL:
        # Ohne konfiguriertes Backend nur lokale Ziele erlauben (Entwicklung).
        return url.startswith("http://localhost") or url.startswith("http://127.0.0.1")
    return url.startswith(f"{CONVEX_SITE_URL}/")


async def _report(callback_url: str, payload: dict) -> None:
    if not _callback_allowed(callback_url):
        print(f"Rueckmeldung abgelehnt, fremdes Ziel: {callback_url[:80]}")
        return
    try:
        await _client.post(
            callback_url,
            json=payload,
            headers={"x-service-secret": SERVICE_SECRET},
            timeout=120.0,
        )
    except Exception as exc:
        print(f"Rueckmeldung fehlgeschlagen: {exc}")


async def _run_job(job: dict) -> None:
    kind = job["kind"]
    path = None
    try:
        path = await _download(job["url"], ".idml" if kind == "idml" else ".pdf")
        if kind == "idml":
            articles = extract_idml(path)
        else:
            articles = extract_pdf(path)

        # Grosse Hefte in Teilen melden: eine Nachricht pro 40 Artikel.
        chunk = 40
        for i in range(0, max(1, len(articles)), chunk):
            part = articles[i : i + chunk]
            await _report(
                job["callbackUrl"],
                {
                    "jobId": job["jobId"],
                    "bookId": job["bookId"],
                    "status": "done" if i + chunk >= len(articles) else "running",
                    "message": f"{len(articles)} Artikel erkannt",
                    "replace": i == 0,
                    "articles": part,
                },
            )
    except Exception as exc:
        traceback.print_exc()
        await _report(
            job["callbackUrl"],
            {
                "jobId": job["jobId"],
                "bookId": job["bookId"],
                "status": "error",
                "message": str(exc)[:500],
            },
        )
    finally:
        if path and os.path.exists(path):
            os.unlink(path)


@app.post("/api/extract")
async def extract(
    payload: dict,
    background: BackgroundTasks,
    x_service_secret: str | None = Header(default=None),
) -> dict[str, Any]:
    if not SERVICE_SECRET or not x_service_secret or not hmac.compare_digest(
        x_service_secret, SERVICE_SECRET
    ):
        raise HTTPException(403, "Falsches Service-Geheimnis")
    for field in ("jobId", "bookId", "kind", "url", "callbackUrl"):
        if not payload.get(field):
            raise HTTPException(400, f"Feld fehlt: {field}")
    if payload["kind"] not in ("pdf", "idml"):
        raise HTTPException(400, "kind muss pdf oder idml sein")
    if not _callback_allowed(payload["callbackUrl"]):
        raise HTTPException(400, "callbackUrl zeigt nicht auf das Backend")

    background.add_task(_run_job, payload)
    return {"accepted": True, "jobId": payload["jobId"]}
