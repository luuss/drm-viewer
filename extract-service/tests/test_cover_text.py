"""Umschlagtafeln aus der Textebene: Bloecke, Zuordnung, ganzseitige Klickflaeche."""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import worker  # noqa: E402
from extractor.model import AssembledArticle, SourceBlock  # noqa: E402
from extractor.article_assembler import assemble_cover_pages  # noqa: E402
from extractor.pdf_extract import blocks_from_text_layer  # noqa: E402
from extractor.toc_layout import TextItem, text_layer_for_cover  # noqa: E402


def _zeile(text: str, y: float, size: float, x0: float = 0.08, breite: float = 0.6) -> TextItem:
    # Hoehe eines Stuecks = Schriftgroesse / Seitenhoehe (842 pt).
    return TextItem(text, x0, y, x0 + breite, y + size / 842, size)


def test_bloecke_aus_der_textebene_liegen_normiert_auf_der_seite():
    items = [
        _zeile("Feuer Frei!", 0.10, 40, 0.08, 0.5),
        _zeile("Die DMZ im Abo nach Hause holen!", 0.16, 24, 0.08, 0.7),
        _zeile("Alle 2 Monate in Wort und Bild über", 0.30, 11),
        _zeile("Militärgeschichte und Sicherheitspolitik.", 0.314, 11),
        _zeile("Jetzt bestellen unter www.dmz-netz.de", 0.45, 11),
    ]
    blocks = blocks_from_text_layer({5: items}, {5: 2400 / 3394})
    assert blocks and all(b.page_index == 5 for b in blocks)
    texte = [b.text for b in blocks]
    # Die zwei eng gesetzten Zeilen bilden einen Absatz, die Ueberschrift
    # und die abgesetzte Zeile jeweils einen eigenen Block.
    assert any("Alle 2 Monate" in t and "Militärgeschichte" in t for t in texte)
    assert any(t.startswith("Feuer Frei") for t in texte)
    kopf = next(b for b in blocks if b.text.startswith("Feuer Frei"))
    assert abs(kopf.x0 - 0.08) < 0.01 and abs(kopf.y0 - 0.10) < 0.01
    assert kopf.size == 40 and kopf.origin != "idml"


def test_umschlagtextebene_findet_die_leserseite_ueber_die_rolle():
    daten = json.dumps(
        {
            "version": 1,
            "cover": True,
            "pages": [
                {"sourcePageIndex": 0, "role": "front_cover", "items": [["DMZ", 0.1, 0.1, 0.3, 0.15, 30]]},
                {"sourcePageIndex": 1, "role": "inside_front", "items": [["Abo", 0.1, 0.1, 0.2, 0.12, 12]]},
                {"sourcePageIndex": 3, "role": "back_cover", "items": []},
            ],
        }
    ).encode()
    pages = [
        {"index": 0, "role": "front_cover"},
        {"index": 1, "role": "inside_front"},
        {"index": 2, "role": "content"},
        {"index": 82, "role": "inside_back"},
        {"index": 83, "role": "back_cover"},
    ]
    seiten = text_layer_for_cover(daten, pages)
    assert set(seiten) == {0, 1, 83}
    assert [i.text for i in seiten[1]] == ["Abo"]
    assert seiten[83] == []


class _Stub:
    """Gerade so viel Job, wie `_build_payload` braucht."""

    job_id = "j1"
    _artwork: dict = {}
    _cover_pages = {1, 83}
    _build_payload = worker.Job._build_payload

    def _store_images(self, *_args):
        return []


def test_umschlaganzeige_ist_ganzseitig_anklickbar():
    def block(seite: int, y: float, text: str) -> SourceBlock:
        return SourceBlock(page_index=seite, text=text, x0=0.1, y0=y, x1=0.6, y1=y + 0.05)

    anzeige = AssembledArticle(title="Feuer Frei!", blocks=[block(1, 0.1, "Feuer Frei!"), block(1, 0.3, "Abo")])
    artikel = AssembledArticle(title="Innen", blocks=[block(2, 0.1, "Innen"), block(3, 0.1, "Weiter")])
    payload = worker.Job._build_payload(_Stub(), [anzeige, artikel], {})
    assert payload[0]["regions"] == [
        {"pageIndex": 1, "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0, "kind": "other"}
    ]
    # Ein Artikel des Innenteils behaelt seine Zeilenflaechen.
    assert all(r["pageIndex"] in (2, 3) and r["x1"] < 1.0 for r in payload[1]["regions"])


def test_je_umschlagtafel_ein_artikel_mit_der_groessten_zeile_als_titel():
    def block(seite: int, y: float, text: str, size: float, drop: bool = False) -> SourceBlock:
        return SourceBlock(
            page_index=seite, text=text, x0=0.1, y0=y, x1=0.6, y1=y + 0.05,
            size=size, max_size=size, drop=drop,
        )

    blocks = [
        block(1, 0.5, "Alle 2 Monate in Wort und Bild", 11),
        block(1, 0.1, "Feuer Frei!", 48),
        block(1, 0.9, "82", 9, drop=True),
        block(83, 0.2, "Der Historiker, für den nur Fakten zählen", 30),
        block(83, 0.4, "320 S., geb., € 29,80", 10),
    ]
    artikel = assemble_cover_pages(blocks)
    assert [(a.title, a.pages) for a in artikel] == [
        ("Feuer Frei!", [1]),
        ("Der Historiker, für den nur Fakten zählen", [83]),
    ]
    # Beiwerk faellt weg, die Reihenfolge der Bloecke bleibt.
    assert [b.text for b in artikel[0].blocks] == ["Alle 2 Monate in Wort und Bild", "Feuer Frei!"]
    assert artikel[0].source == "pdf"


def test_abo_aufruf_wird_seitenlink_statt_artikel():
    stub = _Stub()
    stub.data = {"publicationSlug": "zuerst"}
    stub._cover_pages = {1, 82}
    abo = {
        "order": 0, "title": "Feuer Frei! Die DMZ im Abo nach hause holen!",
        "pageStart": 1, "pageEnd": 1,
        "blocks": [{"text": "Mit Ihrem Abonnement stärken Sie die DMZ. Abonnieren Sie jetzt. Abo-Bestellung"}],
        "regions": [{"pageIndex": 1, "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0, "kind": "other"}],
    }
    innen = {
        "order": 12, "title": "Jetzt abonnieren", "pageStart": 40, "pageEnd": 40,
        "blocks": [{"text": "ZUERST! im Abo: Abonnement, Geschenkabonnement, Probeabo."}],
        "regions": [
            {"pageIndex": 40, "x0": 0.5, "y0": 0.6, "x1": 0.9, "y1": 0.8, "kind": "body"},
            {"pageIndex": 40, "x0": 0.55, "y0": 0.8, "x1": 0.95, "y1": 0.95, "kind": "image"},
        ],
    }
    artikel = {
        "order": 3, "title": "Vergiftete Nachbarschaft", "pageStart": 6, "pageEnd": 9,
        "blocks": [{"text": "Polen verleibte sich 1945 " + "Text " * 900}],
        "regions": [{"pageIndex": 6, "x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.9, "kind": "body"}],
    }
    behalten, links = worker.Job._abo_links(stub, [abo, artikel, innen])
    assert [a["order"] for a in behalten] == [3]
    assert links == [
        {"pageIndex": 1, "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0, "kind": "subscription",
         "publicationSlug": "dmz", "label": "Feuer Frei! Die DMZ im Abo nach hause holen!"},
        {"pageIndex": 40, "x0": 0.5, "y0": 0.6, "x1": 0.95, "y1": 0.95, "kind": "subscription",
         "publicationSlug": "zuerst", "label": "Jetzt abonnieren"},
    ]
