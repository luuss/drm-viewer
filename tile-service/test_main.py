"""Tests fuer das Kachel-Gateway: `python -m pytest` in diesem Ordner."""

import asyncio
import os

os.environ.setdefault("CONVEX_SITE_URL", "https://convex.example.test")
os.environ.setdefault("TILE_SERVICE_SECRET", "test-geheim")
os.environ.pop("MAX_PAGES_PER_MIN", None)
os.environ.pop("MAX_TILES_PER_MIN", None)

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import main  # noqa: E402

# Eine Kennung in der Form, wie Convex sie vergibt.
KENNUNG = "jh70gfhsmykjn6x2ygz8qhpe7h8h41p5"


@pytest.fixture(autouse=True)
def leere_zaehler():
    main._rate.clear()
    yield
    main._rate.clear()


def test_zuegiges_blaettern_bleibt_unter_der_bremse():
    # Eine Minute lang jede Sekunde eine Doppelseite: 120 Seiten, je Seite
    # bis 35 Kacheln. Mit 80 Seiten pro Minute blieb das Heft frueher stehen.
    for _ in range(120):
        main.check_rate("pages:leser:heft", main.MAX_PAGES_PER_MIN, "Seiten")
    for _ in range(120 * 35):
        main.check_rate("tiles:leser:heft", main.MAX_TILES_PER_MIN, "Kacheln")


def test_massenabzug_wird_gebremst_und_nennt_die_wartezeit():
    for _ in range(main.MAX_PAGES_PER_MIN):
        main.check_rate("pages:leser:heft", main.MAX_PAGES_PER_MIN, "Seiten")
    with pytest.raises(HTTPException) as fehler:
        main.check_rate("pages:leser:heft", main.MAX_PAGES_PER_MIN, "Seiten")
    assert fehler.value.status_code == 429
    warten = int(fehler.value.headers["Retry-After"])
    assert 1 <= warten <= 61


def test_abgewiesene_anfragen_zaehlen_nicht_mit():
    for _ in range(3):
        main.check_rate("k", 3, "Seiten")
    for _ in range(5):
        with pytest.raises(HTTPException):
            main.check_rate("k", 3, "Seiten")
    assert len(main._rate["k"]) == 3


def test_andere_leser_und_hefte_haben_eigene_zaehler():
    for _ in range(3):
        main.check_rate("pages:a:heft", 3, "Seiten")
    main.check_rate("pages:b:heft", 3, "Seiten")
    main.check_rate("pages:a:anderes", 3, "Seiten")


def test_gebremste_kachel_verbraucht_kein_ticket(monkeypatch):
    from fastapi.testclient import TestClient

    async def sitzung(token, issue_id=None):
        return {"userId": "leser", "issueId": "heft", "kachelSchluessel": 1}

    monkeypatch.setattr(main, "require_session", sitzung)
    for _ in range(main.MAX_TILES_PER_MIN):
        main.check_rate("tiles:leser:heft", main.MAX_TILES_PER_MIN, "Kacheln")
    ticket = main.neue_tickets("sitzung")[0]
    antwort = TestClient(main.app).get(
        "/api/issue/heft/page/0/tile/0/0/0.jpg",
        headers={"X-Tile-Session": "sitzung", "X-Req": ticket},
    )
    assert antwort.status_code == 429
    assert "Retry-After" in antwort.headers
    # Das Ticket gilt weiter, der Neuversuch des Lesers kann es nehmen.
    assert ticket not in main._tickets_benutzt


def test_artikelbilder_fragen_convex_und_speicher_nur_einmal(monkeypatch):
    aufrufe = {"convex": 0, "speicher": 0}

    async def service_call(path, body):
        aufrufe["convex"] += 1
        return {"issueId": "heft", "bucket": "emag-media", "key": "img/" + body["assetId"]}

    async def fetch_object(url, bucket, key):
        aufrufe["speicher"] += 1
        return b"jpeg"

    monkeypatch.setattr(main, "service_call", service_call)
    monkeypatch.setattr(main, "fetch_object", fetch_object)
    main._asset_cache.clear()
    main._bild_cache.clear()

    async def zweimal():
        for _ in range(2):
            info = await main.resolve_asset(KENNUNG)
            assert await main.load_bild(info) == b"jpeg"

    asyncio.run(zweimal())
    assert aufrufe == {"convex": 1, "speicher": 1}


def test_unsinn_kennungen_fragen_convex_nicht_und_fuellen_keinen_speicher(monkeypatch):
    aufrufe = []

    async def service_call(path, body):
        aufrufe.append(body["assetId"])
        return None

    jetzt = [1000.0]
    monkeypatch.setattr(main, "service_call", service_call)
    monkeypatch.setattr(main.time, "monotonic", lambda: jetzt[0])
    main._asset_cache.clear()

    async def frage(kennung):
        return await main.resolve_asset(kennung)

    # Keine Kennung: gar nicht erst nach Convex.
    for unsinn in ["a1", "../../etc", "x" * 40, "JH70GFHSMYKJN6X2YGZ8QHPE7H8H41P5"]:
        assert asyncio.run(frage(unsinn)) is None
    assert aufrufe == []
    assert len(main._asset_cache) == 0
    # Unbekannt, aber in der richtigen Form: nur kurz gemerkt.
    assert asyncio.run(frage(KENNUNG)) is None
    assert asyncio.run(frage(KENNUNG)) is None
    assert len(aufrufe) == 1
    jetzt[0] += main.UNBEKANNT_TTL + 1
    asyncio.run(frage(KENNUNG))
    assert len(aufrufe) == 2


def test_merkliste_bleibt_klein_und_schnell():
    import time as zeit

    liste = main.Merkliste(100)
    start = zeit.perf_counter()
    for i in range(20_000):
        liste.lege(f"k{i}", i, 60)
    assert len(liste) == 100
    assert zeit.perf_counter() - start < 1.0
    # Das zuletzt Gelegte ist da, das aelteste herausgefallen.
    assert liste.hole("k19999") == (True, 19999)
    assert liste.hole("k0") == (False, None)


def test_neuimport_unter_demselben_schluessel_liefert_das_neue_bild(monkeypatch):
    geholt = []

    async def fetch_object(url, bucket, key):
        geholt.append(key)
        return f"bild-{len(geholt)}".encode()

    jetzt = [1000.0]
    monkeypatch.setattr(main, "fetch_object", fetch_object)
    monkeypatch.setattr(main.time, "monotonic", lambda: jetzt[0])
    main._bild_cache.clear()
    info = {"bucket": "emag-media", "key": "issues/x/images/12-0.1-0.2.jpg", "stand": "1:41000"}

    async def laden(i):
        return await main.load_bild(i)

    assert asyncio.run(laden(info)) == b"bild-1"
    assert asyncio.run(laden(info)) == b"bild-1"
    # Neuimport: gleicher Schluessel, neuer Stand aus Convex.
    assert asyncio.run(laden({**info, "stand": "2:39000"})) == b"bild-2"
    # Ohne Stand (altes Backend) haelt kein Eintrag laenger als fuenf Minuten.
    ohne = {"bucket": "emag-media", "key": "issues/x/images/3-0.5-0.5.jpg"}
    assert asyncio.run(laden(ohne)) == b"bild-3"
    jetzt[0] += main.DATEI_TTL + 1
    assert asyncio.run(laden(ohne)) == b"bild-4"


def test_seitenbild_mit_neuem_stand_wird_neu_geladen(monkeypatch):
    import io

    from PIL import Image

    stand = ["1:100"]
    geholt = []

    async def resolve_page(issue_id, index):
        return {"ready": True, "bucket": "emag-media", "key": f"pages/{issue_id}/{index}/full.jpg", "stand": stand[0]}

    async def fetch_object(url, bucket, key):
        geholt.append(key)
        puffer = io.BytesIO()
        Image.new("RGB", (40 + len(geholt), 60)).save(puffer, "JPEG")
        return puffer.getvalue()

    monkeypatch.setattr(main, "resolve_page", resolve_page)
    monkeypatch.setattr(main, "fetch_object", fetch_object)
    main._page_cache.clear()

    async def laden():
        return await main.load_page("heft", 0)

    assert asyncio.run(laden())[1]["width"] == 41
    assert asyncio.run(laden())[1]["width"] == 41
    stand[0] = "2:120"
    assert asyncio.run(laden())[1]["width"] == 42
    assert len(geholt) == 2
