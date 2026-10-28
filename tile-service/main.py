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
import hashlib
import hmac
import io
import secrets
import os
import re
import time
from collections import OrderedDict, defaultdict, deque
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image

import schutz
import wasserzeichen

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
# Bremse je Leser und Heft. Zuegiges Blaettern eines Menschen bleibt
# darunter: Doppelseiten im Sekundentakt sind 120 Seiten und einige tausend
# Kacheln in der Minute (scharfe Schirme laden je Seite bis 35 Kacheln). Mit
# 80 Seiten und 1200 Kacheln blieben beim Blaettern Seiten bis zu einer
# Minute leer (Pruefung 28.10.2026). Wer ein Heft maschinell abzieht, wird
# weiter gebremst; der Leser wartet bei 429 und fragt selbst nach.
MAX_PAGES_PER_MIN = int(os.environ.get("MAX_PAGES_PER_MIN", "300"))
MAX_TILES_PER_MIN = int(os.environ.get("MAX_TILES_PER_MIN", "6000"))

# Medienspeicher. Liegen die Bilder in einem Eimer statt in der Convex-Ablage,
# hat Convex keine Adresse fuer den Browser — dieser Dienst hat den Zugang und
# liefert sie aus.
MEDIA_BUCKET = os.environ.get("MEDIA_BUCKET", "emag-media")
S3_ENDPOINT_URL = os.environ.get("S3_ENDPOINT_URL", "").strip()

if not CONVEX_SITE_URL or not TILE_SERVICE_SECRET:
    raise RuntimeError("CONVEX_SITE_URL und TILE_SERVICE_SECRET muessen gesetzt sein")

app = FastAPI(title="Kachel-Gateway", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-V", "Retry-After"],
)

_client = httpx.AsyncClient(timeout=60.0, follow_redirects=False)
_page_cache: "OrderedDict[str, tuple[float, Image.Image, dict]]" = OrderedDict()
_session_cache: dict[str, tuple[float, dict]] = {}
_rate: dict[str, deque[float]] = defaultdict(deque)
_usage: dict[str, int] = defaultdict(int)
_lock = asyncio.Lock()
_s3 = None


def s3():
    """Zugang zum Medienspeicher, erst beim ersten Bedarf."""
    global _s3
    if _s3 is None:
        import boto3

        _s3 = boto3.client("s3", endpoint_url=S3_ENDPOINT_URL or None)
    return _s3


async def fetch_object(url: str | None, bucket: str | None, key: str | None) -> bytes:
    """Ein Bild holen — ueber die Convex-Adresse oder aus dem Eimer."""
    if url:
        res = await _client.get(url, timeout=120.0)
        if res.status_code != 200:
            raise HTTPException(502, "Bild nicht ladbar")
        return res.content
    if bucket and key:
        def lade() -> bytes:
            return s3().get_object(Bucket=bucket, Key=key)["Body"].read()

        return await asyncio.to_thread(lade)
    raise HTTPException(409, "Bild nicht abrufbar")


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


# --- Einmal-Tickets ------------------------------------------------------------
# Jede Kachel und jedes Artikelbild braucht ein Ticket, das dieses Gateway
# signiert hat und genau einmal annimmt. Eine nachgeschickte Anfrage (Bildlupe
# wie Imagus, "Copy as cURL", ein zweites Laden) bekommt 403, auch wenn das
# Bild schon da ist. Der Reader holt Tickets in Buendeln
# (`web/src/reader/schutz.ts`), Kopf `X-Req`.
TICKET_TTL = 600
TICKETS_JE_BUENDEL = 64
_tickets_benutzt: dict[str, float] = {}


def _ticket_signatur(token: str, nonce: str) -> str:
    return hmac.new(
        TILE_SERVICE_SECRET.encode(), f"ticket:{token}:{nonce}".encode(), hashlib.sha256
    ).hexdigest()[:24]


def neue_tickets(token: str) -> list[str]:
    jetzt = int(time.time())
    out = []
    for _ in range(TICKETS_JE_BUENDEL):
        nonce = f"{jetzt}-{secrets.token_hex(8)}"
        out.append(f"{nonce}.{_ticket_signatur(token, nonce)}")
    return out


def require_ticket(token: str, ticket: str | None) -> None:
    if not ticket or "." not in ticket:
        raise HTTPException(403, "Ticket fehlt")
    nonce, signatur = ticket.split(".", 1)
    try:
        ausgestellt = int(nonce.split("-", 1)[0])
    except ValueError:
        raise HTTPException(403, "Ticket ungueltig")
    jetzt = time.time()
    if jetzt - ausgestellt > TICKET_TTL:
        raise HTTPException(403, "Ticket abgelaufen")
    if not hmac.compare_digest(signatur, _ticket_signatur(token, nonce)):
        raise HTTPException(403, "Ticket ungueltig")
    if ticket in _tickets_benutzt:
        print("Ticket doppelt benutzt")
        raise HTTPException(403, "Ticket schon benutzt")
    _tickets_benutzt[ticket] = jetzt + TICKET_TTL
    if len(_tickets_benutzt) > 200_000:
        for k, ablauf in list(_tickets_benutzt.items()):
            if ablauf < jetzt:
                _tickets_benutzt.pop(k, None)


_felder: "OrderedDict[tuple[int, int], Image.Image]" = OrderedDict()


def wasserzeichen_feld(session: dict) -> Image.Image | None:
    """Feld der Lesesitzung fuer das unsichtbare Wasserzeichen, oder None."""
    code = session.get("wasserzeichenCode")
    if not code:
        if not session.get("_ohne_wz_gemeldet"):
            session["_ohne_wz_gemeldet"] = True
            print("Wasserzeichen: Sitzung ohne Kennung")
        return None
    tag = int((float(session.get("sitzungSeit") or 0) / 1000 - 1577836800) // 86400) & 0xFFFF
    schluessel = (int(code), tag)
    if schluessel not in _felder:
        print(f"Wasserzeichen: Feld fuer Kennung {code}, Tag {tag}")
        _felder[schluessel] = wasserzeichen.feld(wasserzeichen.verschluesseln(int(code), tag))
        while len(_felder) > 256:
            _felder.popitem(last=False)
    return _felder[schluessel]


def redaktion_erlaubt(asset_id: str, r: str | None) -> bool:
    """Unterschrift aus `convex/assets.ts` (`redaktionsAssetUrl`) pruefen.

    Die Redaktion zeigt Seitenvorschauen als schlichte `<img>`, ohne
    Lesesitzung. Convex gibt solche Adressen nur nach `requireEditor` aus.
    """
    if not r or "." not in r:
        return False
    ablauf, signatur = r.split(".", 1)
    try:
        if int(ablauf) < time.time():
            return False
    except ValueError:
        return False
    erwartet = hmac.new(
        TILE_SERVICE_SECRET.encode(),
        f"redaktion:{asset_id}:{ablauf}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signatur, erwartet)


def require_fetch(request: Request) -> None:
    """Nur `fetch` aus der eigenen Seite.

    Browser schicken `Sec-Fetch-*` von selbst und lassen Seiten sie nicht
    faelschen. Adresszeile (`dest=document`), `<img>` (`dest=image`) und
    fremde Seiten (`site=cross-site`) kommen so nicht an Inhalte.
    """
    site = request.headers.get("sec-fetch-site")
    ziel = request.headers.get("sec-fetch-dest")
    if site and site != "same-origin":
        raise HTTPException(403, "Nur aus dem Reader")
    if ziel and ziel != "empty":
        raise HTTPException(403, "Nur aus dem Reader")


def check_rate(key: str, limit: int, what: str) -> None:
    now = time.time()
    hits = _rate[key]
    while hits and now - hits[0] > 60:
        hits.popleft()
    if len(hits) >= limit:
        # Wann der aelteste Zugriff aus dem Fenster faellt: so lange wartet
        # der Leser, bevor er von selbst nachfragt (`web/src/reader/nachladen.ts`).
        frei = max(1, int(60 - (now - hits[0])) + 1)
        raise HTTPException(
            429, f"Zu viele {what} pro Minute", headers={"Retry-After": str(frei)}
        )
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


# Welche Datei hinter einer Seite steht, wird kurz gemerkt. Das Bild selbst
# liegt unter seinem Speicherschluessel im Cache, nicht unter Heft und Seite:
# nach einem erneuten Import zeigt dieselbe Seitennummer auf eine neue Datei,
# und der alte Schluessel lieferte sonst weiter das alte Bild (DMZ 170 zeigte
# am 30.09. als Titel noch eine Anzeige aus dem ersten Lauf).
RESOLVE_TTL = 30


class Merkliste:
    """Kurzzeitspeicher mit fester Groesse: was laenger nicht gefragt wurde,
    faellt als erstes heraus, und jeder Eintrag hat eine Ablaufzeit.

    Frueher durchsuchte jeder neue Eintrag ab 4096 den ganzen Speicher nach
    Abgelaufenem; wer Unsinn-Kennungen schickte, brachte so die Ereignis-
    schleife ins Stocken.
    """

    def __init__(self, groesse: int) -> None:
        self.groesse = groesse
        self._daten: "OrderedDict[str, tuple[float, Any]]" = OrderedDict()

    def hole(self, key: str) -> tuple[bool, Any]:
        hit = self._daten.get(key)
        if hit is None:
            return False, None
        if hit[0] <= time.monotonic():
            self._daten.pop(key, None)
            return False, None
        self._daten.move_to_end(key)
        return True, hit[1]

    def lege(self, key: str, wert: Any, ttl: float) -> None:
        self._daten[key] = (time.monotonic() + ttl, wert)
        self._daten.move_to_end(key)
        while len(self._daten) > self.groesse:
            self._daten.popitem(last=False)

    def __len__(self) -> int:
        return len(self._daten)

    def clear(self) -> None:
        self._daten.clear()

# Auch der Speicherschluessel reicht allein nicht: der Import legt Seiten und
# Artikelbilder unter festen Namen ab (`images/{seite}-{x0}-{y0}.jpg`) und
# ueberschreibt sie beim Neuimport. Darum gehoert der Stand aus Convex
# (Zeitpunkt und Groesse, `assetStand`) mit in den Schluessel, und kein
# Eintrag lebt laenger als fuenf Minuten.
DATEI_TTL = 300


def speicher_schluessel(info: dict) -> str:
    ort = f"{info.get('bucket')}/{info.get('key')}" if info.get("key") else str(info.get("url"))
    return f"{ort}#{info.get('stand') or ''}"
_resolve_cache = Merkliste(4096)


async def resolve_page(issue_id: str, index: int) -> dict:
    rkey = f"{issue_id}:{index}"
    da, info = _resolve_cache.hole(rkey)
    if da:
        return info
    info = await service_call(
        "/service/page/resolve", {"issueId": issue_id, "index": index}
    )
    if not info or not info.get("ready"):
        raise HTTPException(409, "Seite ist noch nicht aufbereitet")
    _resolve_cache.lege(rkey, info, RESOLVE_TTL)
    return info


# Artikelbilder: wohin eine Kennung zeigt und die Bytes dahinter, kurz
# gemerkt. Ein bildreicher Artikel fragte sonst je Bild erst Convex und dann
# den Medienspeicher, und wer zwischen Artikeln hin und her blaettert, holte
# dieselben Bilder jedes Mal neu. Verwuerfelt wird weiter je Sitzung.
ASSET_TTL = 30
BILD_CACHE = int(os.environ.get("BILD_CACHE", "48"))
# Eine unbekannte Kennung nur kurz: sie kam vor jeder Sitzungspruefung.
UNBEKANNT_TTL = 5
# Form einer Convex-Kennung (Crockford-Base32); alles andere fragt Convex gar
# nicht erst (`web/src/lib/kennung.ts`).
KENNUNG = re.compile(r"^[0-9a-hjkmnp-tv-z]{31,37}$")
_asset_cache = Merkliste(2048)
_bild_cache: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()


async def resolve_asset(asset_id: str) -> dict | None:
    if not KENNUNG.match(asset_id):
        return None
    da, info = _asset_cache.hole(asset_id)
    if da:
        return info
    info = await service_call("/service/asset/resolve", {"assetId": asset_id})
    _asset_cache.lege(asset_id, info, ASSET_TTL if info else UNBEKANNT_TTL)
    return info


async def load_bild(info: dict) -> bytes:
    key = speicher_schluessel(info)
    now = time.monotonic()
    hit = _bild_cache.get(key)
    if hit and hit[0] > now:
        _bild_cache.move_to_end(key)
        return hit[1]
    daten = await fetch_object(info.get("url"), info.get("bucket"), info.get("key"))
    _bild_cache[key] = (now + DATEI_TTL, daten)
    _bild_cache.move_to_end(key)
    while len(_bild_cache) > BILD_CACHE:
        _bild_cache.popitem(last=False)
    return daten


async def load_page(issue_id: str, index: int) -> tuple[Image.Image, dict]:
    info = await resolve_page(issue_id, index)
    key = speicher_schluessel(info)
    async with _lock:
        hit = _page_cache.get(key)
        if hit and hit[0] > time.monotonic():
            _page_cache.move_to_end(key)
            return hit[1], hit[2]

    daten = await fetch_object(info.get("url"), info.get("bucket"), info.get("key"))
    image = Image.open(io.BytesIO(daten)).convert("RGB")
    meta = {"width": image.width, "height": image.height}
    async with _lock:
        _page_cache[key] = (time.monotonic() + DATEI_TTL, image, meta)
        _page_cache.move_to_end(key)
        while len(_page_cache) > PAGE_CACHE:
            _page_cache.popitem(last=False)
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
    request: Request,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> dict:
    require_fetch(request)
    session = await require_session(x_tile_session)
    return {
        "issueId": session["issueId"],
        # Kurzkennung fuers Wasserzeichen im Reader.
        "watermark": session.get("watermark", ""),
        # Schluessel zum Zusammensetzen der verwuerfelten Kacheln und Bilder.
        # Der Geheimwert fuer die Schrift bleibt hier.
        "k": session.get("kachelSchluessel", 0),
    }


# Namen nach aussen absichtlich nichtssagend (`f/<n>`, `n`, `X-Req`, `X-V`):
# wer den Reader zerlegt, soll am Namen nicht ablesen, was dahinter steckt.
_SCHRIFT_NR = {"0": "sans", "1": "serif", "2": "serif-kursiv"}


@app.get("/api/issue/{issue_id}/f/{nr}")
async def schrift(
    issue_id: str,
    nr: str,
    request: Request,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> Response:
    """Leseschrift dieser Sitzung: kennt nur ihre verschluesselten Zeichen.

    Ohne Dateiendung in der Adresse: Cloudflare cacht nach Endung und
    lieferte sonst eine Schrift (oder einen 404) an fremde Sitzungen.
    """
    familie = _SCHRIFT_NR.get(nr)
    if familie is None:
        raise HTTPException(404, "Nicht gefunden")
    require_fetch(request)
    session = await require_session(x_tile_session, issue_id)
    daten = await asyncio.to_thread(
        schutz.schrift, int(session.get("schutzSeed", 0)), familie
    )
    return Response(
        content=daten,
        media_type="font/woff2",
        headers={"Cache-Control": "private, no-store"},
    )


@app.get("/api/asset/{asset_id}.jpg")
async def asset(
    asset_id: str,
    request: Request,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
    x_ticket: str | None = Header(default=None, alias="X-Req"),
) -> Response:
    """Ein Bild aus dem Medienspeicher ausliefern.

    Liegt der Medienspeicher in einem Eimer, hat Convex keine Adresse dafuer;
    der Browser kaeme also nicht an Titelbilder und Artikelbilder. Dieser Dienst
    hat den Zugang — und die Rechtepruefung gibt es hier ohnehin schon.

    Ein Titelbild ist oeffentlich: es steht im Kiosk, auch ohne Anmeldung. Alles
    andere gehoert zum bezahlten Inhalt und braucht eine gueltige Lesesitzung
    fuer genau dieses Heft. Es kommt verwuerfelt (`X-V: 1`); der Reader holt
    es mit der Sitzung im Kopf, setzt es zusammen und malt es auf eine Flaeche.
    Die Sitzung in der Adresse (`?s=`) gibt es nicht mehr.
    """
    info = await resolve_asset(asset_id)
    if not info:
        raise HTTPException(404, "Unbekanntes Bild")
    if info.get("public"):
        daten = await fetch_object(info.get("url"), info.get("bucket"), info.get("key"))
        return Response(
            content=daten,
            media_type=info.get("contentType") or "image/jpeg",
            headers={"Cache-Control": "private, max-age=3600"},
        )
    if redaktion_erlaubt(asset_id, request.query_params.get("r")):
        daten = await fetch_object(info.get("url"), info.get("bucket"), info.get("key"))
        return Response(
            content=daten,
            media_type=info.get("contentType") or "image/jpeg",
            headers={"Cache-Control": "private, no-store"},
        )
    require_fetch(request)
    session = await require_session(x_tile_session, info.get("issueId"))
    # Erst bremsen, dann das Ticket verbrauchen: ein 429 kostete sonst ein
    # Ticket, und jeder Neuversuch des Lesers leerte seinen Vorrat weiter.
    check_rate(
        f'assets:{session.get("userId")}:{info.get("issueId")}',
        MAX_TILES_PER_MIN,
        "Bilder",
    )
    require_ticket(x_tile_session or "", x_ticket)
    daten = await load_bild(info)
    seed = schutz.fnv1a32(f'{session.get("kachelSchluessel", 0)}:asset:{asset_id}')

    feld = wasserzeichen_feld(session)

    def verwuerfelt() -> bytes:
        bild = Image.open(io.BytesIO(daten)).convert("RGB")
        if feld is not None:
            bild = wasserzeichen.einbetten(bild, feld, (0.0, 0.0, 1.0, 1.0))
        return schutz.als_jpeg(schutz.verwuerfeln(bild, seed), quality=88)

    return Response(
        content=await asyncio.to_thread(verwuerfelt),
        media_type="image/jpeg",
        headers={"Cache-Control": "private, no-store", "X-V": "1"},
    )


@app.get("/api/issue/{issue_id}/n")
async def tickets(
    issue_id: str,
    request: Request,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> Response:
    """Ein Buendel Einmal-Tickets fuer Kacheln und Bilder dieser Sitzung."""
    require_fetch(request)
    session = await require_session(x_tile_session, issue_id)
    check_rate(f'tickets:{session.get("userId")}:{issue_id}', 120, "Tickets")
    return Response(
        content='{"t":[' + ",".join(f'"{t}"' for t in neue_tickets(x_tile_session or "")) + "]}",
        media_type="application/json",
        headers={"Cache-Control": "private, no-store"},
    )


@app.get("/api/issue/{issue_id}/page/{index}/info")
async def page_info(
    issue_id: str,
    index: int,
    request: Request,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
) -> dict:
    require_fetch(request)
    session = await require_session(x_tile_session, issue_id)
    # Metadaten und Bildkacheln brauchen getrennte Zaehler. Mit demselben Key
    # fuellten die vielen Kacheln einer einzigen Seite auch das deutlich
    # kleinere Seitenlimit; danach lieferte bereits der naechste /info-Aufruf
    # faelschlich 429 und der Reader blieb leer.
    check_rate(
        f'pages:{session.get("userId")}:{issue_id}',
        MAX_PAGES_PER_MIN,
        "Seiten",
    )
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
    request: Request,
    x_tile_session: str | None = Header(default=None, alias="X-Tile-Session"),
    x_ticket: str | None = Header(default=None, alias="X-Req"),
) -> Response:
    require_fetch(request)
    session = await require_session(x_tile_session, issue_id)
    # Wie bei den Bildern: die Bremse vor dem Ticket (der Schluessel haengt
    # an der schon geprueften Sitzung).
    check_rate(
        f'tiles:{session.get("userId")}:{issue_id}',
        MAX_TILES_PER_MIN,
        "Kacheln",
    )
    require_ticket(x_tile_session or "", x_ticket)
    _usage[x_tile_session or ""] += 1

    image, meta = await load_page(issue_id, index)
    scale = 2 ** max(0, level)
    # Aufrunden, nicht abschneiden: OpenSeadragon rechnet die Stufengroesse
    # ebenfalls aufgerundet. Sonst sitzen die Randkacheln um ein Pixel daneben
    # und es bleibt ein Streifen stehen.
    width = max(1, -(-meta["width"] // scale))
    height = max(1, -(-meta["height"] // scale))
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
        max(1, -(-(box[2] - box[0]) // scale)),
        max(1, -(-(box[3] - box[1]) // scale)),
    )
    if cropped.size != target:
        cropped = cropped.resize(target, Image.LANCZOS)

    # Unsichtbares Wasserzeichen der Sitzung, in Seitenkoordinaten: alle
    # Kacheln aller Stufen ergeben zusammen dasselbe Feld ueber der Seite.
    feld = wasserzeichen_feld(session)
    if feld is not None:
        cropped = wasserzeichen.einbetten(
            cropped,
            feld,
            (
                box[0] / meta["width"],
                box[1] / meta["height"],
                box[2] / meta["width"],
                box[3] / meta["height"],
            ),
        )
    # Verwuerfelt ausliefern; zusammengesetzt wird erst im Reader
    # (`web/src/reader/schutz.ts`). Wer die Kachel speichert, hat Bloecke.
    seed = schutz.fnv1a32(
        f'{session.get("kachelSchluessel", 0)}:{issue_id}:{index}:{level}:{col}:{row}'
    )
    return Response(
        content=schutz.als_jpeg(schutz.verwuerfeln(cropped, seed), quality=82),
        media_type="image/jpeg",
        # Haengt an der Sitzung: eine neue Sitzung verwuerfelt anders.
        headers={"Cache-Control": "private, no-store"},
    )


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    return response
