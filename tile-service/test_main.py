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
            info = await main.resolve_asset("a1")
            assert await main.load_bild(info) == b"jpeg"

    asyncio.run(zweimal())
    assert aufrufe == {"convex": 1, "speicher": 1}
