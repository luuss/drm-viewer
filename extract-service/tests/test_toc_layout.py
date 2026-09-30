"""Klickflaechen des Inhaltsverzeichnisses auf der Textebene.

Die Zahlen sind den drei Reihen nachempfunden: DMZ (Seitenzahl gross links
vom Titel, zweizeilige Titel, Unterzeile), ZUERST! (Seitenzahl rechts,
gleicher Eintrag in Spalte und Anreisser) und DMZ-Zeitgeschichte (Seitenzahl
am Spaltenrand als eigenes Stueck).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.model import TocHint  # noqa: E402
from extractor.toc_layout import (  # noqa: E402
    TextItem,
    parse_text_layer,
    refine_toc_hints,
    segments_of,
    text_layer_for_pages,
)


def item(text: str, x0: float, y0: float, x1: float, y1: float, size: float = 11.0) -> TextItem:
    return TextItem(text, x0, y0, x1, y1, size)


def hint(label: str, printed: int, *, y0: float, x0: float = 0.05, details: str = "") -> TocHint:
    # Schaetzwert aus dem Satz: Rahmenbreite, Hoehe nach Zeichenanteil.
    return TocHint(
        label=label,
        page_index=printed - 2,
        toc_page_index=2,
        x0=x0,
        y0=y0,
        x1=x0 + 0.44,
        y1=y0 + 0.02,
        printed=printed,
        details=details,
    )


# --- Zeilen und Spalten ------------------------------------------------------


def test_stuecke_einer_zeile_werden_zusammengefasst_spalten_getrennt():
    segs = segments_of(
        [
            item("von", 0.093, 0.261, 0.123, 0.275),
            item("Adel", 0.127, 0.261, 0.166, 0.275),
            item("Deutschland", 0.56, 0.262, 0.65, 0.276),
        ]
    )
    assert [s.text for s in segs] == ["von Adel", "Deutschland"]


def test_grosse_seitenzahl_nimmt_die_zeile_darunter_nicht_mit():
    # "10" reicht vom ersten Titelzeile bis in die zweite hinein.
    segs = segments_of(
        [
            item("10", 0.050, 0.2461, 0.077, 0.2675, 18),
            item("Weltgewandter Offizier", 0.093, 0.2467, 0.285, 0.2603, 11.5),
            item("von Adel", 0.093, 0.2609, 0.166, 0.2746, 11.5),
        ]
    )
    assert [s.text for s in segs] == ["10", "Weltgewandter Offizier", "von Adel"]
    assert segs[0].numeric and segs[0].zahl == 10


# --- Eintraege finden ---------------------------------------------------------


def _dmz_seite() -> list[TextItem]:
    """Zwei Eintraege der DMZ-Spalte samt Rubrik und Unterzeilen."""
    return [
        item("Soldatenporträt", 0.093, 0.228, 0.207, 0.244, 13),
        item("10", 0.050, 0.2461, 0.077, 0.2675, 18),
        item("Weltgewandter Offizier", 0.093, 0.2467, 0.285, 0.2603, 11.5),
        item("von", 0.093, 0.2609, 0.123, 0.2746, 11.5),
        item("Adel", 0.127, 0.2609, 0.166, 0.2746, 11.5),
        item("Fridolin von Senger und Etterlin", 0.093, 0.2758, 0.317, 0.2877, 10),
        item("erwarb sich als Diplomat", 0.093, 0.2889, 0.348, 0.3007, 10),
        item("Orden und Ehrenzeichen", 0.093, 0.354, 0.274, 0.370, 13),
        item("15", 0.050, 0.372, 0.077, 0.393, 18),
        item("Orden vom Zähringer Löwen", 0.093, 0.376, 0.332, 0.390, 11.5),
        # Rechte Spalte, gleiche Hoehe wie der erste Eintrag.
        item("52", 0.517, 0.2484, 0.544, 0.2698, 18),
        item("Der Gefangenschaft entflohen", 0.56, 0.249, 0.807, 0.263, 11.5),
    ]


def test_eintrag_liegt_auf_zahl_titel_und_unterzeile():
    hints = [
        hint(
            "Weltgewandter Offizier von Adel",
            10,
            y0=0.206,
            details="Fridolin von Senger und Etterlin erwarb sich als Diplomat",
        ),
        hint("Orden vom Zähringer Löwen", 15, y0=0.354),
        hint("Der Gefangenschaft entflohen", 52, y0=0.178, x0=0.514),
    ]
    out, bilanz = refine_toc_hints(hints, {2: _dmz_seite()})

    assert bilanz == {"placed": 3, "byNumber": 0, "unplaced": 0, "noText": 0}
    erster = next(h for h in out if h.printed == 10)
    # Von der Seitenzahl links bis zum Ende der laengsten Unterzeile.
    assert erster.x0 == round(0.050 - 0.004, 5)
    assert abs(erster.x1 - (0.348 + 0.004)) < 1e-9
    assert abs(erster.y0 - (0.2461 - 0.003)) < 1e-9
    assert abs(erster.y1 - (0.3007 + 0.003)) < 1e-9
    # Die Rubrikzeile darueber gehoert nicht dazu (nur der Rand reicht an sie heran).
    assert erster.y0 > 0.243

    zweiter = next(h for h in out if h.printed == 15)
    assert abs(zweiter.y0 - (0.372 - 0.003)) < 1e-9
    assert abs(zweiter.y1 - (0.393 + 0.003)) < 1e-9

    rechts = next(h for h in out if h.printed == 52)
    assert rechts.x0 < 0.52 and rechts.x1 > 0.8
    # Die Flaechen ueberschneiden sich nicht.
    assert erster.y1 < zweiter.y0
    assert erster.x1 < rechts.x0


def test_seitenzahl_rechts_am_spaltenrand_gehoert_zur_flaeche():
    seite = [
        item("Standartenführer", 0.3635, 0.6465, 0.4954, 0.6596),
        item("Alfons Rebane", 0.3635, 0.6596, 0.4741, 0.6727),
        item("10", 0.5967, 0.6596, 0.6149, 0.6727),
        item("Ein Porträt zum 50. Todestag", 0.3635, 0.6727, 0.5245, 0.6822, 8),
        item("Kalenderblatt Personen", 0.3635, 0.6976, 0.5423, 0.7107),
        item("16", 0.5967, 0.6976, 0.6149, 0.7107),
    ]
    hints = [
        hint("Standartenführer Alfons Rebane", 10, y0=0.73, details="Ein Porträt zum 50. Todestag"),
        hint("Kalenderblatt Personen", 16, y0=0.75),
    ]
    out, bilanz = refine_toc_hints(hints, {2: seite})
    assert bilanz["placed"] == 2
    rebane, kalender = out[0], out[1]
    assert abs(rebane.x1 - (0.6149 + 0.004)) < 1e-9
    assert abs(rebane.y0 - (0.6465 - 0.003)) < 1e-9
    assert abs(rebane.y1 - (0.6822 + 0.003)) < 1e-9
    assert abs(kalender.y0 - (0.6976 - 0.003)) < 1e-9
    assert rebane.y1 < kalender.y0


def test_gleicher_eintrag_in_spalte_und_anreisser_wird_je_nach_lage_gewaehlt():
    seite = [
        item("Vergiftete Nachbarschaft", 0.06, 0.13, 0.25, 0.142),
        item("8", 0.31, 0.13, 0.32, 0.142),
        item("8", 0.36, 0.18, 0.375, 0.2, 18),
        item("Vergiftete Nachbarschaft", 0.39, 0.184, 0.6, 0.197),
    ]
    hints = [
        hint("Vergiftete Nachbarschaft", 8, y0=0.083, x0=0.048),
        hint("Vergiftete Nachbarschaft", 8, y0=0.181, x0=0.357),
    ]
    out, bilanz = refine_toc_hints(hints, {2: seite})
    assert bilanz["placed"] == 2
    links = next(h for h in out if h.x0 < 0.3)
    mitte = next(h for h in out if h.x0 > 0.3)
    assert abs(links.x1 - (0.32 + 0.004)) < 1e-9
    assert abs(mitte.x0 - (0.36 - 0.004)) < 1e-9


def test_anreisser_unterzeile_beginnt_an_der_seitenzahl():
    """ZUERST!-Anreisser: grosse Zahl, Titel eingerueckt, Unterzeile buendig zur Zahl."""
    seite = [
        item("8", 0.357, 0.168, 0.375, 0.19, 18),
        item("Vergiftete Nachbarschaft", 0.39, 0.172, 0.576, 0.186, 11.5),
        item("Polen verleibte sich 1945 Ostdeutschland ein und", 0.357, 0.194, 0.63, 0.205, 9),
        item("vertrieb von dort Millionen Deutsche.", 0.357, 0.206, 0.58, 0.217, 9),
        # Naechster Anreisser, deutlich darunter.
        item("24", 0.357, 0.346, 0.38, 0.368, 18),
    ]
    out, bilanz = refine_toc_hints(
        [
            hint(
                "Vergiftete Nachbarschaft",
                8,
                y0=0.181,
                x0=0.357,
                details="Polen verleibte sich 1945 Ostdeutschland ein und vertrieb von dort Millionen Deutsche.",
            )
        ],
        {2: seite},
    )
    assert bilanz["placed"] == 1
    assert abs(out[0].x0 - (0.357 - 0.004)) < 1e-9
    assert abs(out[0].x1 - (0.63 + 0.004)) < 1e-9
    assert abs(out[0].y1 - (0.217 + 0.003)) < 1e-9


def test_zahl_in_der_naechsten_spalte_wird_nicht_genommen():
    seite = [
        item("Neuaufstellung", 0.0619, 0.7249, 0.1772, 0.738),
        item("4", 0.3042, 0.7249, 0.3133, 0.738),
        item("Europäische Freiwillige", 0.3635, 0.7273, 0.5415, 0.7404),
    ]
    out, _ = refine_toc_hints([hint("Neuaufstellung", 4, y0=0.63)], {2: seite})
    assert abs(out[0].x1 - (0.3133 + 0.004)) < 1e-9


def test_ohne_treffer_findet_die_seitenzahl_den_eintrag():
    """Weicht der Titel ab, zaehlt die freistehende Seitenzahl."""
    seite = [
        item("36", 0.050, 0.4979, 0.077, 0.5193, 18),
        item("Putins Untergangswaffe", 0.093, 0.4985, 0.267, 0.5122, 11.5),
    ]
    out, bilanz = refine_toc_hints([hint("Putins Weltuntergangswaffe", 36, y0=0.43)], {2: seite})
    assert bilanz == {"placed": 0, "byNumber": 1, "unplaced": 0, "noText": 0}
    assert abs(out[0].x0 - (0.050 - 0.004)) < 1e-9
    assert abs(out[0].x1 - (0.267 + 0.004)) < 1e-9


def test_unauffindbarer_eintrag_verliert_seine_klickflaeche():
    seite = [item("Ganz anderer Text", 0.1, 0.1, 0.3, 0.115)]
    out, bilanz = refine_toc_hints([hint("Verrat an der Truppe", 6, y0=0.12)], {2: seite})
    assert bilanz["unplaced"] == 1
    assert out[0].toc_page_index is None
    assert out[0].label == "Verrat an der Truppe"


def test_ohne_textebene_bleibt_der_schaetzwert():
    h = hint("Verrat an der Truppe", 6, y0=0.12)
    out, bilanz = refine_toc_hints([h], {})
    assert bilanz["noText"] == 1
    assert out == [h]


def test_getrennte_woerter_und_anfuehrungszeichen_stoeren_nicht():
    seite = [
        item("66", 0.517, 0.395, 0.544, 0.415, 18),
        item("Arctic Convoy –", 0.56, 0.391, 0.678, 0.404, 11.5),
        item("Todesfalle Eismeer", 0.56, 0.405, 0.70, 0.418, 11.5),
        item("Das norwegische Kino-", 0.56, 0.419, 0.705, 0.43, 10),
        item("Kriegsdrama besticht", 0.56, 0.431, 0.731, 0.443, 10),
    ]
    out, bilanz = refine_toc_hints(
        [
            hint(
                "Arctic Convoy – Todesfalle Eismeer",
                66,
                y0=0.369,
                x0=0.514,
                details="Das norwegische Kino-Kriegsdrama besticht",
            )
        ],
        {2: seite},
    )
    assert bilanz["placed"] == 1
    assert abs(out[0].y1 - (0.443 + 0.003)) < 1e-9
    assert abs(out[0].x0 - (0.517 - 0.004)) < 1e-9


def test_eng_gesetzte_nachbarn_teilen_sich_die_luecke():
    """Der Rand reicht sonst in den naechsten Eintrag hinein."""
    seite = [
        item("Vergiftete Nachbarschaft", 0.063, 0.1236, 0.250, 0.1366),
        item("8", 0.305, 0.1236, 0.314, 0.1366),
        item("Im komplexbeladenen Polen nimmt", 0.063, 0.1366, 0.256, 0.1461, 9),
        item("die Deutschenfeindlichkeit weiter zu", 0.063, 0.1461, 0.259, 0.1556, 9),
        item("„Slawischer Landraub“", 0.063, 0.1580, 0.237, 0.1711),
        item("18", 0.296, 0.1580, 0.314, 0.1711),
    ]
    out, _ = refine_toc_hints(
        [
            hint(
                "Vergiftete Nachbarschaft",
                8,
                y0=0.083,
                details="Im komplexbeladenen Polen nimmt die Deutschenfeindlichkeit weiter zu",
            ),
            hint("„Slawischer Landraub“", 18, y0=0.125),
        ],
        {2: seite},
    )
    erster = next(h for h in out if h.printed == 8)
    zweiter = next(h for h in out if h.printed == 18)
    mitte = (0.1556 + 0.1580) / 2
    assert abs(erster.y1 - mitte) < 1e-9
    assert abs(zweiter.y0 - mitte) < 1e-9
    # Nebeneinander stehende Flaechen bleiben unangetastet.
    seite.append(item("Deutschland", 0.56, 0.124, 0.65, 0.137))
    out, _ = refine_toc_hints(
        [hint("Vergiftete Nachbarschaft", 8, y0=0.083), hint("Deutschland", 5, y0=0.1, x0=0.5)],
        {2: seite},
    )
    daneben = next(h for h in out if h.printed == 5)
    assert abs(daneben.y0 - (0.124 - 0.003)) < 1e-9


# --- Datei lesen --------------------------------------------------------------


def test_textebene_wird_auf_leserseiten_umgeschluesselt():
    daten = json.dumps(
        {
            "version": 1,
            "pages": [
                {"sourcePageIndex": 0, "items": [["Editorial", 0.1, 0.1, 0.2, 0.12, 12]]},
                {"sourcePageIndex": 1, "items": [["Inhalt", 0.1, 0.03, 0.18, 0.05, 16], ["kaputt"]]},
            ],
        }
    ).encode()
    je_quelle = parse_text_layer(daten)
    assert [i.text for i in je_quelle[1]] == ["Inhalt"]
    # Innenteil beginnt bei Leserseite 1 (davor der Umschlag).
    seiten = text_layer_for_pages(daten, [(0, 1), (1, 2)])
    assert set(seiten) == {1, 2}
    assert seiten[2][0].size == 16


def test_unlesbare_textebene_ist_ein_fehler():
    import pytest

    with pytest.raises(ValueError):
        parse_text_layer(b"kein json")
    with pytest.raises(ValueError):
        parse_text_layer(b'{"pages": "nein"}')
