"""Schnittmarken erkennen (extractor/schnittmarken.py).

Vorlagen unter fixtures/schnittmarken/: gespeicherte Seitenbilder der Anlage
digital.weltkrieg-online.de (05.11.2026), 1400 Punkte breit wie beim Import.
Zwei Innenseiten aus Heften ohne IDML mit Anschnitt und Marken, vier aus
Blitzkrieg 3 (IDML, also beschnitten): Textseite, Titel und U4 mit Bild bis
an den Rand, ganzseitige Anzeige. Das Seiteninnere ist weiss gemacht, damit
die Dateien klein bleiben; die Erkennung liest nur den aeusseren Rand.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.schnittmarken import Schnitt, schnittmarken, umrechnen, zuschneiden  # noqa: E402

VORLAGEN = Path(__file__).parent / "fixtures" / "schnittmarken"


def _bild(name: str) -> Image.Image:
    return Image.open(VORLAGEN / name)


@pytest.mark.parametrize(
    "name", ["mit-marken-doppelband-154-s10.jpg", "mit-marken-originalband-300-s10.jpg"]
)
def test_marken_auf_den_schnittkanten(name):
    s = schnittmarken(_bild(name))
    assert s is not None
    # Die Linien liegen 63 Punkte vom Rand, rundum gleich.
    assert abs(s.links - 63) <= 1 and abs(s.oben - 63) <= 1
    assert abs(s.rechts - 1336) <= 1 and abs(s.unten - 1863) <= 1
    neu = zuschneiden(_bild(name), s)
    # Netzformat A4.
    assert abs(neu.width / neu.height - 210 / 297) < 0.002


@pytest.mark.parametrize(
    "name",
    [
        "ohne-textseite-blitzkrieg-3-s35.jpg",
        "ohne-titel-blitzkrieg-3-u1.jpg",
        "ohne-anzeige-blitzkrieg-3-s36.jpg",
        "ohne-u4-blitzkrieg-3.jpg",
    ],
)
def test_beschnittene_seite_bleibt(name):
    assert schnittmarken(_bild(name)) is None


def _seite(w=1400, h=1927, rand=63, ecken=("lo", "ro", "lu", "ru"), bild_in_ecke=False):
    """Weisse Seite mit Marken wie im Druck-PDF (Linie 1 Punkt, 45 Punkte lang)."""
    im = Image.new("L", (w, h), 255)
    z = ImageDraw.Draw(im)
    r, b = w - 1 - rand, h - 1 - rand
    lang = 45
    if "lo" in ecken:
        z.line([(rand, 0), (rand, lang)], fill=0)
        z.line([(0, rand), (lang, rand)], fill=0)
    if "ro" in ecken:
        z.line([(r, 0), (r, lang)], fill=0)
        z.line([(w - 1 - lang, rand), (w - 1, rand)], fill=0)
    if "lu" in ecken:
        z.line([(rand, h - 1 - lang), (rand, h - 1)], fill=0)
        z.line([(0, b), (lang, b)], fill=0)
    if "ru" in ecken:
        z.line([(r, h - 1 - lang), (r, h - 1)], fill=0)
        z.line([(w - 1 - lang, b), (w - 1, b)], fill=0)
    if bild_in_ecke:
        z.rectangle([0, 0, 40, 40], fill=60)
    return im


def test_kuenstliche_marken():
    s = schnittmarken(_seite())
    assert s == Schnitt(63, 63, 1336, 1863, 1400, 1927)


def test_drei_ecken_reichen_nicht():
    assert schnittmarken(_seite(ecken=("lo", "ro", "lu"))) is None


def test_ungleicher_rand_ist_kein_schnitt():
    im = _seite()
    # Rechts eine zweite Linie weiter innen: der Rand waere ungleich.
    z = ImageDraw.Draw(im)
    z.line([(1300, 0), (1300, 45)], fill=0)
    z.line([(1300, 1927 - 46), (1300, 1926)], fill=0)
    assert schnittmarken(im) is None


def test_bild_bis_in_die_ecke_ist_kein_schnitt():
    assert schnittmarken(_seite(bild_in_ecke=True)) is None


def test_zugeschnittene_seite_hat_keine_marken_mehr():
    s = schnittmarken(_seite())
    neu = zuschneiden(_seite(), s)
    assert neu.size == (1273, 1800)
    assert schnittmarken(neu) is None


def test_umrechnen():
    s = Schnitt(63, 63, 1336, 1863, 1400, 1927)
    x, y = umrechnen(63 / 1400, 1863 / 1927, s.anteile)
    assert abs(x) < 1e-9 and abs(y - 1) < 1e-9
    x, y = umrechnen(0.5, 0.5, s.anteile)
    assert abs(x - 0.5) < 0.001 and abs(y - 0.5) < 0.001


def test_textebene_umrechnen():
    import json

    from extractor.schnittmarken import textebene_umrechnen

    a = Schnitt(63, 63, 1336, 1863, 1400, 1927).anteile
    doc = {
        "pages": [
            {
                "sourcePageIndex": 8,
                "items": [
                    # Zeile im Satzspiegel.
                    ["Feldwebel Stamm", 0.2, 0.5, 0.4, 0.51, 11.5],
                    # Druckvermerk unten im Rand: faellt weg.
                    ["7mag Innenteil.indd 98", 0.3, 0.981, 0.5, 0.99, 7],
                ],
            },
            {"sourcePageIndex": 9, "items": [["Seite 9", 0.2, 0.5, 0.4, 0.51, 11.5]]},
        ]
    }
    neu = json.loads(textebene_umrechnen(json.dumps(doc).encode(), {8: a}))
    s8, s9 = neu["pages"]
    assert [it[0] for it in s8["items"]] == ["Feldwebel Stamm"]
    x0, y0 = umrechnen(0.2, 0.5, a)
    assert s8["items"][0][1:3] == [round(x0, 5), round(y0, 5)]
    assert s8["items"][0][5] == 11.5
    # Nicht zugeschnittene Seite bleibt.
    assert s9["items"][0][1:5] == [0.2, 0.5, 0.4, 0.51]
    assert neu["beschnitt"] == {"8": [round(v, 6) for v in a]}
    # Zweiter Lauf: nichts mehr zu tun.
    assert textebene_umrechnen(json.dumps(neu).encode(), {8: a}) is None


# --- Worker ----------------------------------------------------------------

import io  # noqa: E402
import json  # noqa: E402

import worker  # noqa: E402
from storage import StoredObject  # noqa: E402


class _Ablage:
    uses_s3 = True

    def __init__(self, dateien):
        self.dateien = dict(dateien)

    def get(self, key):
        if key not in self.dateien:
            raise KeyError(key)
        return self.dateien[key]

    def put(self, key, data, content_type):
        self.dateien[key] = data
        return StoredObject(key, "emag-media", None, len(data))


class _Convex:
    def __init__(self):
        self.gesendet = []

    def post(self, path, body):
        self.gesendet.append((path, body))
        if path == "/service/pages/beschnitten":
            return {"angewendet": [s["index"] for s in body["seiten"]], "flaechen": 0, "links": 0, "absaetze": 0, "uebersprungen": 0}
        return "asset-id"


class _BeschnittJob:
    BESCHNITT_TOLERANZ = worker.Job.BESCHNITT_TOLERANZ
    _schnittmarken = worker.Job._schnittmarken
    _textebene_zuschneiden = worker.Job._textebene_zuschneiden
    _page_image = worker.Job._page_image
    _store_cover = worker.Job._store_cover

    def __init__(self, ablage, kind="beschnitt"):
        self.job_id = "job-1"
        self.issue_id = "issue-1"
        self.publication_id = "pub-1"
        self.storage = ablage
        self.convex = _Convex()
        self.data = {"kind": kind}

    def beat(self, *_a):
        pass


def _jpeg(im):
    puffer = io.BytesIO()
    im.convert("RGB").save(puffer, "JPEG", quality=92)
    return puffer.getvalue()


def test_worker_schneidet_zu_und_rechnet_textebene_um():
    text = {
        "pages": [
            {"sourcePageIndex": 0, "items": [["Zeile", 0.2, 0.5, 0.4, 0.51, 11.5], ["Vermerk", 0.3, 0.985, 0.5, 0.99, 7]]},
            {"sourcePageIndex": 1, "items": [["Zeile", 0.2, 0.5, 0.4, 0.51, 11.5]]},
        ]
    }
    titel = Image.new("RGB", (1400, 1980), (236, 103, 8))
    ablage = _Ablage(
        {
            "s/u1.jpg": _jpeg(titel),
            "s/2.jpg": _jpeg(_seite()),
            "s/3.jpg": _jpeg(_seite()),
            "text.json": json.dumps(text).encode(),
        }
    )
    pages = [
        {"index": 0, "role": "front_cover", "sourceAssetId": "umschlag", "sourcePageIndex": 0, "previewKey": "s/u1.jpg"},
        {"index": 2, "role": "content", "sourceAssetId": "innen", "sourcePageIndex": 0, "previewKey": "s/2.jpg"},
        {"index": 3, "role": "content", "sourceAssetId": "innen", "sourcePageIndex": 1, "previewKey": "s/3.jpg"},
    ]
    sources = [{"kind": "text", "role": "inner", "assetId": "t", "assetKey": "text.json"}]
    blobs = {"t": ablage.dateien["text.json"]}
    job = _BeschnittJob(ablage)
    meldung = job._schnittmarken(pages, sources, blobs)

    assert "2 Seiten auf das Netzformat zugeschnitten" in meldung
    assert "Textebene von 2 Seiten umgerechnet" in meldung
    [(pfad, body)] = [g for g in job.convex.gesendet if g[0] == "/service/pages/beschnitten"]
    assert [s["index"] for s in body["seiten"]] == [2, 3]
    s2 = body["seiten"][0]
    assert (s2["width"], s2["height"]) == (1273, 1800)
    assert s2["altKey"] == "s/2.jpg" and s2["neuKey"].endswith("netz-" + s2["neuKey"].rsplit("netz-", 1)[1])
    # Neues Bild abgelegt, altes bleibt; ohne Marken.
    neu = Image.open(io.BytesIO(ablage.dateien[s2["neuKey"]]))
    assert neu.size == (1273, 1800) and schnittmarken(neu) is None
    assert "s/2.jpg" in ablage.dateien
    # Der Titel ohne Marken bleibt, wie er ist.
    assert pages[0]["previewKey"] == "s/u1.jpg" and not pages[0].get("beschnitt")
    assert pages[1]["previewKey"] == s2["neuKey"] and pages[1]["beschnitt"]["x0"] == s2["x0"]
    # Textebene umgerechnet, Vermerk im Rand weg, Sicherung angelegt.
    umgerechnet = json.loads(blobs["t"])
    assert [it[0] for it in umgerechnet["pages"][0]["items"]] == ["Zeile"]
    assert json.loads(ablage.dateien["text.json"]) == umgerechnet
    assert json.loads(ablage.dateien["text.json.vor-beschnitt"]) == text

    # Zweiter Lauf auf dem neuen Stand: nichts mehr zu tun.
    job2 = _BeschnittJob(ablage)
    assert job2._schnittmarken(pages, sources, blobs) == ""
    assert not [g for g in job2.convex.gesendet if g[0] == "/service/pages/beschnitten"]


def test_worker_laesst_uneinheitliche_marken_stehen():
    schief = _seite(rand=80)
    ablage = _Ablage({"s/2.jpg": _jpeg(_seite()), "s/3.jpg": _jpeg(schief)})
    pages = [
        {"index": 2, "role": "content", "sourceAssetId": "innen", "sourcePageIndex": 0, "previewKey": "s/2.jpg"},
        {"index": 3, "role": "content", "sourceAssetId": "innen", "sourcePageIndex": 1, "previewKey": "s/3.jpg"},
    ]
    job = _BeschnittJob(ablage)
    meldung = job._schnittmarken(pages, [], {})
    assert "2 Seiten mit uneinheitlichen Marken nicht zugeschnitten" in meldung
    assert not [g for g in job.convex.gesendet if g[0] == "/service/pages/beschnitten"]


def _mit_bild_im_anschnitt():
    """Seite mit Marken, ein Bild laeuft unten rechts in den Anschnitt bis in
    die Ecke und verdeckt die waagrechte Marke dort (wie Magazin 83, S. 21)."""
    im = _seite()
    ImageDraw.Draw(im).rectangle([900, 1500, 1399, 1926], fill=70)
    return im


def test_marken_passen_bei_bild_im_anschnitt():
    from extractor.schnittmarken import marken_passen

    ref = schnittmarken(_seite())
    im = _mit_bild_im_anschnitt()
    assert schnittmarken(im) is None
    assert marken_passen(im, ref) >= 5
    # Eine gleich grosse Seite ganz ohne Marken traegt keinen Beleg.
    assert marken_passen(Image.new("L", (1400, 1927), 255), ref) == 0


def test_worker_uebernimmt_schnitt_fuer_seite_mit_bild_im_anschnitt():
    ablage = _Ablage(
        {
            "s/2.jpg": _jpeg(_seite()),
            "s/3.jpg": _jpeg(_mit_bild_im_anschnitt()),
            "s/4.jpg": _jpeg(Image.new("L", (1400, 1927), 255)),
        }
    )
    pages = [
        {"index": i, "role": "content", "sourceAssetId": f"q{i}", "sourcePageIndex": i - 2, "previewKey": f"s/{i}.jpg"}
        for i in (2, 3, 4)
    ]
    job = _BeschnittJob(ablage)
    meldung = job._schnittmarken(pages, [], {})
    [(_pfad, body)] = [g for g in job.convex.gesendet if g[0] == "/service/pages/beschnitten"]
    # Auch ueber verschiedene Quellen hinweg: gleiche Groesse, gleiche Marken.
    assert [s["index"] for s in body["seiten"]] == [2, 3]
    assert "1 Seiten ohne erkennbare Marken gelassen" in meldung
    assert pages[2]["previewKey"] == "s/4.jpg"


def test_worker_zweiter_lauf_nimmt_schnitt_der_frueheren_seiten():
    ablage = _Ablage({"s/3.jpg": _jpeg(_mit_bild_im_anschnitt())})
    a = schnittmarken(_seite()).anteile
    pages = [
        # Im ersten Lauf zugeschnitten.
        {"index": 2, "role": "content", "sourcePageIndex": 0, "previewKey": "s/2-netz.jpg",
         "beschnitt": {"x0": a[0], "y0": a[1], "x1": a[2], "y1": a[3]}},
        # Damals uebrig geblieben: eigene Pruefung scheitert am Bild in der Ecke.
        {"index": 3, "role": "content", "sourcePageIndex": 1, "previewKey": "s/3.jpg"},
    ]
    job = _BeschnittJob(ablage)
    job._schnittmarken(pages, [], {})
    [(_pfad, body)] = [g for g in job.convex.gesendet if g[0] == "/service/pages/beschnitten"]
    assert [(s["index"], s["width"], s["height"]) for s in body["seiten"]] == [(3, 1273, 1800)]


def test_foto_bis_an_den_unteren_rand_vier_marken_reichen():
    """Wie Magazin 83, S. 26: unten laeuft ein Foto ueber die ganze Breite bis
    an den Bildrand, die unteren Marken sind darauf nicht zu sehen."""
    from extractor.schnittmarken import MARKEN_MINDESTENS, marken_passen

    ref = schnittmarken(_seite())
    im = _seite()
    ImageDraw.Draw(im).rectangle([0, 1000, 1399, 1926], fill=40)
    assert schnittmarken(im) is None
    assert marken_passen(im, ref) == 4 >= MARKEN_MINDESTENS


def test_doppelseitenfoto_zwei_marken_am_bund_reichen():
    """Ganzseitiges Foto bis an drei Bildraender; nur am Bund (links) bleiben
    die waagrechten Marken oben und unten sichtbar."""
    from extractor.schnittmarken import MARKEN_MINDESTENS, marken_passen

    ref = schnittmarken(_seite())
    im = _seite()
    ImageDraw.Draw(im).rectangle([50, 0, 1399, 1926], fill=50)
    assert schnittmarken(im) is None
    assert marken_passen(im, ref) == 2 >= MARKEN_MINDESTENS
