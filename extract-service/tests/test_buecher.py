"""Einzelne Buecher auf Bucherseiten und in Besprechungen — an echten Seiten der Hefte.

Die Vorlagen in fixtures/buecher/ enthalten Absaetze und Bildrahmen
ausgewaehlter Seiten aus dem Satz (erzeugt mit _scratch/buecher_fixture.py).
Seitenzahlen sind hier die Quellseiten der Satzdatei.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.buecher import (  # noqa: E402
    Buch,
    buecher_der_seiten,
    haupttitel,
)
from extractor.model import SourceBlock, SourceImage  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "buecher")


def _laden(name: str) -> tuple[list[SourceBlock], list[SourceImage]]:
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        d = json.load(f)
    blocks = [
        SourceBlock(
            page_index=b["page"],
            text=b["text"],
            x0=b["box"][0],
            y0=b["box"][1],
            x1=b["box"][2],
            y1=b["box"][3],
            origin="idml",
            frame_id=b["frame"],
            style_name=b["style"],
            frame_box=tuple(b["frameBox"]) if b["frameBox"] else None,
        )
        for b in d["blocks"]
    ]
    images = [
        SourceImage(page_index=i["page"], x0=i["box"][0], y0=i["box"][1], x1=i["box"][2],
                    y1=i["box"][3], link=i["link"])
        for i in d["images"]
    ]
    return blocks, images


def _je_titel(buecher: list[Buch]) -> dict[str, Buch]:
    return {b.titel: b for b in buecher}


def _ueberlappen(a: Buch, b: Buch) -> bool:
    return min(a.x1, b.x1) - max(a.x0, b.x0) > 0.01 and min(a.y1, b.y1) - max(a.y0, b.y0) > 0.01


ZUERST_SEITE_79 = {
    "Warum macht ihr uns kaputt?": "Peter Hahne",
    "Merkels Werk": "Gerald Grosz",
    "DDR – CDU – AfD": "Alexander Gauland",
    "Deutschland ist nicht mehr sicher": "Manuel Ostermann",
    "Halbmondsüchtig": "Sophie Liebnitz",
    "Der Staatsverrat": "Gunter Frank/Martina Binnig/Kay Klapproth",
    "Stasi": "Klaus-Rüdiger Mai",
    "An der Grenze": "Jan Solwyn",
    "Die Wokeness-Illusion": "Alexander Marguier/Ben Krischke (Hg.)",
    "Rechtsbankrott": "Eike Lauterbach",
    "Militärmuseen in Deutschland": "Harry Lippmann",
    "Land der Wunder": "Michael Klonovsky",
    "Zerstörung der Meinungsfreiheit": "Christian Zeller",
    "Die Akte Epstein": "Collin McMahon",
    "Tag der Befreiung?": "Hubertus Knabe",
}


def test_zuerst_bucherseite_jedes_buch_eine_flaeche_mit_umschlag():
    blocks, images = _laden("zuerst-3-2026.json")
    seite = [b for b in buecher_der_seiten(blocks, images) if b.page_index == 76]
    assert {b.titel: b.autor for b in seite} == ZUERST_SEITE_79
    # Fuenf Spalten, drei Reihen: keine Flaeche liegt auf einer anderen.
    for i, a in enumerate(seite):
        for b in seite[i + 1 :]:
            assert not _ueberlappen(a, b), (a.titel, b.titel)
    # Die Flaeche ist das Umschlagbild; der Text darunter bleibt dem Artikel
    # (Tipp auf den Text oeffnet den Text, Tipp auf den Umschlag den Laden).
    kaputt = _je_titel(seite)["Warum macht ihr uns kaputt?"]
    assert kaputt.y0 < 0.08 and 0.2 < kaputt.y1 < 0.23
    assert 0.04 < kaputt.x0 < 0.07 and kaputt.x1 < 0.22


def test_zuerst_besprechungen_auf_dem_umschlagbild():
    blocks, images = _laden("zuerst-3-2026.json")
    seite = _je_titel([b for b in buecher_der_seiten(blocks, images) if b.page_index == 75])
    assert set(seite) == {
        "Verheimlicht, vertuscht, vergessen 2026",
        "Indogermanen",
        "Deutsche Legenden",
    }
    # Die Flaeche ist das Bild "verheimlicht 2026.tif", nicht die ganze Spalte.
    w = seite["Verheimlicht, vertuscht, vergessen 2026"]
    assert w.autor == "Gerhard Wisnewski"
    assert (round(w.x0, 2), round(w.y0, 2), round(w.x1, 2), round(w.y1, 2)) == (0.11, 0.07, 0.26, 0.23)


def test_zuerst_buch_im_interview_verfasser_ueber_zwei_zeilen():
    blocks, images = _laden("zuerst-3-2026.json")
    seite = [b for b in buecher_der_seiten(blocks, images) if b.page_index == 17]
    assert [(b.titel, b.autor) for b in seite] == [
        ("80 Thesen zur Vertreibung", "Alfred de Zayas/Konrad Badenheuer")
    ]


def test_dmz_artikelnummern_und_umschlag_neben_dem_text():
    blocks, images = _laden("dmz-170.json")
    seite = _je_titel([b for b in buecher_der_seiten(blocks, images) if b.page_index == 11])
    # Das Eichenlaub-Werk in drei Baenden (mehrere Nummern) ist kein einzelnes Buch.
    assert set(seite) == {
        "Die deutschen Generalfeldmarschälle und Großadmirale 1936–1945",
        "Die Brillantenträger der deutschen Wehrmacht 1941–1945",
        "Die deutsche Militärelite",
    }
    assert seite["Die deutsche Militärelite"].referenz == "102256"
    # Das Umschlagbild steht links neben dem Text, das Foto rechts gehoert
    # nicht dazu ("deutsche_Soldaten.tif" nennt kein Buch).
    elite = seite["Die deutsche Militärelite"]
    assert elite.x0 < 0.06 and elite.x1 < 0.5 and elite.y0 > 0.7


def test_dmz_bucherseite_und_besprechung():
    blocks, images = _laden("dmz-170.json")
    alle = buecher_der_seiten(blocks, images)
    assert len([b for b in alle if b.page_index == 56]) == 15
    besprochen = {b.titel: b.autor for b in alle if b.page_index == 78}
    assert besprochen["Warum Krieg"] == "Richard Overy"


def test_dmz_zeitgeschichte_katalog_und_kalender():
    blocks, images = _laden("dmz-zeitgeschichte-80.json")
    alle = buecher_der_seiten(blocks, images)
    nummern = {b.titel: b.referenz for b in alle if b.page_index in (18, 62)}
    assert nummern["Die Generale der Waffen‑SS"] == "101208"
    assert nummern["Soldatenköpfe"] == "460721"
    willrich = [b for b in alle if b.titel == "Soldatenköpfe"][0]
    assert willrich.autor == "Wolfgang Willrich"
    # Impressum und Kleinanzeigen tragen Preise, sind aber keine Buecher.
    assert not any(t.startswith(("Impressum", "Kleinanzeigen")) for t in nummern)


def _absatz(text: str, style: str = "Text", frame: str = "u1") -> SourceBlock:
    return SourceBlock(
        page_index=20, text=text, x0=0.37, y0=0.65, x1=0.94, y1=0.94, origin="idml",
        frame_id=frame, style_name=style, frame_box=(0.37, 0.65, 0.94, 0.94),
    )


def test_zwei_buecher_in_einem_rahmen_je_eigener_umschlag():
    # ZUERST! 6/2025, S. 21 unten: Anzeige unter dem Interview, zwei Buecher
    # desselben Verfassers in einem Textrahmen, die Umschlaege darin.
    blocks = [
        _absatz("Manfred Kleine-Hartlage: BRD-Sprech"),
        _absatz("Worte als Waffe der Umerziehung. – Die Fortsetzung seines Erfolgsbuches. "
                "220 S., Pb., € 20,–"),
        _absatz("Manfred Kleine-Hartlage"),
        _absatz("Die Sprache der BRD"),
        _absatz("131 Unwörter und ihre politische Bedeutung. 272 S., Pb., € 18,–"),
    ]
    images = [
        SourceImage(page_index=20, x0=0.78, y0=0.65, x1=0.94, y1=0.82, link="Sprache der BRD.tif"),
        SourceImage(page_index=20, x0=0.37, y0=0.76, x1=0.51, y1=0.93, link="BRD-Sprech.jpg"),
    ]
    buecher = _je_titel(buecher_der_seiten(blocks, images))
    assert set(buecher) == {"BRD-Sprech", "Die Sprache der BRD"}
    assert buecher["BRD-Sprech"].autor == "Manfred Kleine-Hartlage"
    assert (buecher["BRD-Sprech"].x0, buecher["BRD-Sprech"].y0) == (0.37, 0.76)
    assert (buecher["Die Sprache der BRD"].x0, buecher["Die Sprache der BRD"].y0) == (0.78, 0.65)


def test_zwei_buecher_ohne_passendes_bild_keine_flaeche():
    blocks = [
        _absatz("Manfred Kleine-Hartlage: BRD-Sprech"),
        _absatz("Worte als Waffe. 220 S., Pb., € 20,–"),
        _absatz("Die Sprache der BRD"),
        _absatz("131 Unwörter. 272 S., Pb., € 18,–"),
    ]
    images = [SourceImage(page_index=20, x0=0.78, y0=0.65, x1=0.94, y1=0.82, link="foto 3.tif")]
    # Welches Bild welches Buch zeigt, verraet nur der Dateiname. Ohne ihn
    # keine Flaeche: der Tipp oeffnet die Anzeige mit beiden Knoepfen.
    assert buecher_der_seiten(blocks, images) == []


def test_ein_buch_mit_zwei_preisen_bleibt_eins():
    blocks = [
        _absatz("Peter Hahne"),
        _absatz("Warum macht ihr uns kaputt?"),
        _absatz("Text über das Buch. 160 S., geb., € 20,– (D)"),
        _absatz("€ 20,60 (A)"),
    ]
    buecher = buecher_der_seiten(blocks, [])
    assert [(b.titel, b.autor) for b in buecher] == [("Warum macht ihr uns kaputt?", "Peter Hahne")]


def test_doppelpunkt_ohne_namen_bleibt_titel():
    for zeile in ("Kalender: Männer der Waffen-SS 2026", "2025: Verheimlicht – vertuscht"):
        blocks = [_absatz(zeile), _absatz("Beschreibung. 120 S., geb., € 18,–")]
        assert [(b.titel, b.autor) for b in buecher_der_seiten(blocks, [])] == [(zeile, None)]


def test_link_fuer_das_backend():
    buch = Buch(page_index=78, x0=0.05, y0=0.07, x1=0.21, y1=0.34,
                titel="Warum macht ihr uns kaputt?", autor="Peter Hahne")
    link = buch.als_link()
    assert link["kind"] == "shop" and link["single"] is True
    assert link["queries"] == ["Warum macht ihr uns kaputt?", "Warum macht ihr uns kaputt? Hahne"]
    # Der Trenner " · " kennzeichnet die Buchflaeche (convex/pageLinks.ts).
    assert link["label"] == "Warum macht ihr uns kaputt? · Peter Hahne"
    assert "reference" not in link


def test_haupttitel_ohne_untertitel():
    assert haupttitel("Verheimlicht, vertuscht, vergessen 2026 – Das andere Jahrbuch") == (
        "Verheimlicht, vertuscht, vergessen 2026"
    )
    assert haupttitel("Indogermanen: Herkunft, Eigenschaften") == "Indogermanen"
    assert haupttitel("Stasi") == "Stasi"


def test_worker_legt_je_buch_einen_seitenlink_an():
    import worker

    class _Stub:
        data = {"publicationSlug": "zuerst"}
        _cover_pages: set[int] = set()
        job_id = "test"

    stub = _Stub()
    stub._satz_fuer_buecher = _laden("zuerst-3-2026.json")
    behalten, links = worker.Job._seitenlinks(stub, [])
    assert behalten == []
    buecher = [l for l in links if " · " in (l.get("label") or "")]
    assert len([l for l in buecher if l["pageIndex"] == 76]) == 15
    assert all(l["kind"] == "shop" and l["single"] for l in buecher)
    # Eine Seite, die schon ganz zu einem Seitenlink gehoert, bekommt keine Buecher.
    ganz = [{"pageIndex": 76, "x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0}]
    assert not [l for l in worker.Job._buchflaechen(stub, ganz) if l["pageIndex"] == 76]
