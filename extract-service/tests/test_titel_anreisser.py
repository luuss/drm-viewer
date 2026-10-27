"""Die Anreisser der Titelseite fuehren zum richtigen Artikel.

Vorlage: die Textebene der Titelseite von ZUERST! 3/2026, wie der Browser sie
aus dem Umschlag-PDF liest (samt schraegem Satz), und das Inhaltsverzeichnis
desselben Hefts aus tests/fixtures/toc.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.idml_extract import toc_from_idml  # noqa: E402
from extractor.model import TocHint  # noqa: E402
from extractor.titel_anreisser import stichworte, titel_anreisser  # noqa: E402
from extractor.toc_layout import TextItem, text_layer_for_cover  # noqa: E402
from tests.test_toc_real import _laden  # noqa: E402

VORLAGE = Path(__file__).parent / "fixtures" / "titel" / "zuerst-3-2026-u1.json"


def _hint(label: str, seite: int, details: str) -> TocHint:
    return TocHint(label, seite, None, 0, 0, 0, 0, details=details)


def _zuerst():
    daten, blocks, _ = _laden("zuerst-3-2026")
    hints = toc_from_idml(blocks, daten["printed_offset"])
    items = text_layer_for_cover(
        VORLAGE.read_bytes(), [{"index": 0, "role": "front_cover"}], mit_gedrehtem=True
    )[0]
    return items, hints


def test_jeder_anreisser_trifft_seinen_artikel():
    items, hints = _zuerst()
    gefunden = {a.label.split()[0]: a.page_index for a in titel_anreisser(items, hints)}
    assert gefunden == {
        "Migrationswende-Lüge": 28,  # Staatsversagen statt Migrationswende
        "Gegenwind": 44,  # Gefaehrliches Umfragetief (ICE, Trump, Groenland)
        "„Europa": 66,  # Scheil ueber den Obersten Kriegsrat
        "Vergiftete": 6,  # Titelthema
        "In": 6,  # Unterzeile des Titelthemas
        "„Verbrechen": 16,  # schraeg: Gespraech mit de Zayas
    }


def test_kopf_preise_und_randtext_bekommen_keine_flaeche():
    items, hints = _zuerst()
    labels = " ".join(a.label for a in titel_anreisser(items, hints))
    for fremd in ("zuerst.de", "Jahrgang", "8,70", "17834", "Österreich"):
        assert fremd not in labels


def test_leiste_reicht_bis_zum_naechsten_feld():
    items, hints = _zuerst()
    leiste = sorted(
        (a for a in titel_anreisser(items, hints) if a.y1 < 0.27), key=lambda a: a.x0
    )
    assert len(leiste) == 3
    assert len({(a.y0, a.y1) for a in leiste}) == 1
    for links, rechts in zip(leiste, leiste[1:]):
        assert 0 < rechts.x0 - links.x1 < 0.02
    # Die Flaeche des Trump-Anreissers umfasst auch sein Bild rechts vom Text.
    assert leiste[1].x1 > 0.65


def test_flaechen_liegen_nicht_uebereinander():
    items, hints = _zuerst()
    flaechen = titel_anreisser(items, hints)
    for i, a in enumerate(flaechen):
        for b in flaechen[i + 1 :]:
            assert min(a.x1, b.x1) <= max(a.x0, b.x0) or min(a.y1, b.y1) <= max(a.y0, b.y0)


def test_ohne_verzeichnis_keine_flaechen():
    items, _ = _zuerst()
    assert titel_anreisser(items, []) == []


def test_unsicherer_anreisser_bleibt_ohne_link():
    hints = [
        _hint("Trump in Davos", 10, "Grönland und Zölle"),
        _hint("Trump und die ICE", 20, "Grönland im Blick"),
    ]
    items = [TextItem("Gegenwind für Trump", 0.1, 0.1, 0.4, 0.12, 12.0)]
    assert titel_anreisser(items, hints) == []


def test_schatten_und_doppelbuchstaben():
    assert stichworte("IInn PPoolleenn nniimmmmtt") == {"polen", "nimmt"}
    doppelt = [TextItem("In Polen nimmt", 0.1, 0.6, 0.4, 0.63, 30.0)] * 2
    hints = [
        _hint("Vergiftete Nachbarschaft", 6, "In Polen nimmt die Deutschenfeindlichkeit zu"),
        _hint("Entwertung", 48, "Polen muß Ehen anerkennen"),
    ]
    # Das Gewicht eines Wortes kommt aus seiner Seltenheit im ganzen Heft.
    hints += [_hint(f"Thema {n}", 50 + n, f"Bericht Nummer {n}") for n in range(8)]
    (a,) = titel_anreisser(doppelt, hints)
    assert a.page_index == 6 and a.label == "In Polen nimmt"


def test_gedrehter_satz_nur_auf_wunsch():
    daten = VORLAGE.read_bytes()
    seiten = [{"index": 0, "role": "front_cover"}]
    ohne = text_layer_for_cover(daten, seiten)[0]
    mit = text_layer_for_cover(daten, seiten, mit_gedrehtem=True)[0]
    assert all(i.winkel == 0 for i in ohne)
    assert any(i.winkel == 43 for i in mit)
