"""Die Inhaltsseiten echter Hefte, wie sie im Reader liegen.

Die Vorlagen unter fixtures/toc/ tragen je Reihe die Satzbloecke der
Inhaltsseite und die Textebene, die der Browser mit pdf.js daraus liest —
DMZ (zwei Spalten, Seitenzahl gross links), DMZ-Zeitgeschichte (drei
Spalten unter dem Editorial, Seitenzahl am Spaltenrand) und ZUERST! (drei
Spalten, Seitenzahl rechts, Anreisser in der Mitte). Erzeugt mit
`_scratch/textebene/fixture.py`.

Geprueft wird, was fuer den Leser zaehlt: jeder Eintrag aus dem Satz findet
seine Zeilen, jede Flaeche enthaelt die gedruckte Seitenzahl und den Anfang
des Titels, und keine zwei Flaechen liegen uebereinander.
"""

from __future__ import annotations

import json
import os
import re
import sys
from itertools import combinations
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.idml_extract import toc_from_idml  # noqa: E402
from extractor.model import SourceBlock, TocHint  # noqa: E402
from extractor.toc_layout import TextItem, _norm, refine_toc_hints  # noqa: E402

VORLAGEN = Path(__file__).parent / "fixtures" / "toc"


def _laden(name: str) -> tuple[dict, list[SourceBlock], list[TextItem]]:
    daten = json.loads((VORLAGEN / f"{name}.json").read_text())
    blocks = [
        SourceBlock(
            page_index=daten["toc_page"],
            text=b["text"],
            x0=b["x0"],
            y0=b["y0"],
            x1=b["x1"],
            y1=b["y1"],
            origin="idml",
            story_id=b["story"],
            style_name=b["style"],
        )
        for b in daten["blocks"]
    ]
    items = [TextItem(*i) for i in daten["items"]]
    return daten, blocks, items


def _drin(i: TextItem, h: TocHint) -> bool:
    mx, my = (i.x0 + i.x1) / 2, (i.y0 + i.y1) / 2
    return h.x0 <= mx <= h.x1 and h.y0 <= my <= h.y1


def _flaeche(h: TocHint) -> float:
    return max(0.0, h.x1 - h.x0) * max(0.0, h.y1 - h.y0)


@pytest.mark.parametrize("name", ["dmz-170", "dmz-zeitgeschichte-80", "zuerst-3-2026"])
def test_jeder_eintrag_liegt_auf_seiner_zeile(name: str):
    daten, blocks, items = _laden(name)
    hints = toc_from_idml(blocks, daten["printed_offset"])
    assert len(hints) == daten["entries"], [h.label for h in hints]

    platziert, bilanz = refine_toc_hints(hints, {daten["toc_page"]: items})
    assert bilanz == {
        "placed": len(hints),
        "byNumber": 0,
        "unplaced": 0,
        "noText": 0,
        "overlapping": 0,
    }

    for h in platziert:
        assert h.toc_page_index == daten["toc_page"]
        # Die gedruckte Seitenzahl steht in der Flaeche — frei oder am Anfang
        # bzw. Ende der Titelzeile.
        zahl = str(h.printed)
        assert any(
            _drin(i, h)
            and (
                i.text.strip() == zahl
                or i.text.strip().startswith(zahl + " ")
                or i.text.strip().endswith(" " + zahl)
            )
            for i in items
        ), (h.label, h.printed)
        # Und der Anfang des Titels (das erste Wort; ein Bindestrich teilt
        # in der Textebene das Wort in Stuecke).
        anfang = _norm(re.search(r"[^\W\d_]+", h.label).group(0))
        assert any(_drin(i, h) and anfang in _norm(i.text) for i in items), h.label

    for a, b in combinations(platziert, 2):
        ueberlappung = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0)) * max(
            0.0, min(a.y1, b.y1) - max(a.y0, b.y0)
        )
        assert ueberlappung <= 0.02 * min(_flaeche(a), _flaeche(b)), (a.label, b.label)


def test_zuerst_anreisser_und_umbrochene_titel():
    """Die Eigenheiten von ZUERST!: derselbe Eintrag zweimal, Titel ueber zwei Absaetze."""
    daten, blocks, items = _laden("zuerst-3-2026")
    hints = toc_from_idml(blocks, daten["printed_offset"])
    platziert, _ = refine_toc_hints(hints, {daten["toc_page"]: items})

    nachbarschaft = sorted(
        (h for h in platziert if h.label == "Vergiftete Nachbarschaft"), key=lambda h: h.x0
    )
    assert len(nachbarschaft) == 2
    spalte, anreisser = nachbarschaft
    assert spalte.x1 < 0.34 and anreisser.x0 > 0.34
    # Der Anreisser reicht ueber seine drei Unterzeilen.
    assert anreisser.y1 - anreisser.y0 > 0.05

    labels = {h.label for h in platziert}
    assert "Wahlrechtsentzug statt Strafpsychiatrie" in labels
    assert "Claus-M. Wolfschlag: Die Kolumne" in labels
    assert {h.section for h in platziert if h.printed == 39} == {"Österreich"}


def test_dmz_zeitgeschichte_rubriken_mit_seitenzahl():
    daten, blocks, items = _laden("dmz-zeitgeschichte-80")
    hints = toc_from_idml(blocks, daten["printed_offset"])
    platziert, _ = refine_toc_hints(hints, {daten["toc_page"]: items})
    nach_zahl = {h.printed: h for h in platziert}
    assert nach_zahl[16].label == "Kalenderblatt Personen"
    assert nach_zahl[10].label == "Standartenführer Alfons Rebane"
    assert nach_zahl[10].section == "Soldatenporträt"
    # Drei Spalten: links, Mitte, rechts.
    assert nach_zahl[4].x0 < 0.1 and 0.3 < nach_zahl[10].x0 < 0.4 and nach_zahl[50].x0 > 0.6
