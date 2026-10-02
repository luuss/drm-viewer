"""Stehende Rubriken heissen nach ihrer Rubrik und stehen im Verzeichnis."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import worker  # noqa: E402
from extractor.model import AssembledArticle, SourceBlock, TocHint  # noqa: E402
from extractor.rubriken import kopfzeilen, seitenrubriken, stehende_rubrik, titel_bereinigen  # noqa: E402


def test_stehende_rubrik_am_anfang_des_textes():
    assert stehende_rubrik("Verehrter Leser, kaum ist das Jahr 2025 zur Neige gegangen") == "Editorial"
    assert stehende_rubrik("Sehr geehrte Leser,") == "Editorial"
    assert stehende_rubrik("EDITORIAL") == "Editorial"
    assert stehende_rubrik("Impressum Deutsche Militärzeitschrift (DMZ) • Selent") == "Impressum"
    assert stehende_rubrik("Historischer Kalender März März 933: Abschluß") == "Historischer Kalender"
    assert stehende_rubrik("Leserbriefe/Impressum") == "Leserbriefe"
    assert stehende_rubrik("Zu „Im Panzerwahn“ in DMZ 169 Drohnen für die Truppe") == "Leserbriefe"
    assert stehende_rubrik("Die Kolumne") == "Die Kolumne"
    # Kein Rubrikname, nur ein Wort, das so beginnt.
    assert stehende_rubrik("Editoriale Freiheit ist wichtig") is None
    assert stehende_rubrik("Nachrichtenmagazin in Not") is None
    assert stehende_rubrik("Vergiftete Nachbarschaft") is None
    assert stehende_rubrik(None) is None


def test_seitenrubriken_aus_dem_satz():
    def block(seite, stil, text):
        return SourceBlock(page_index=seite, text=text, x0=0, y0=0, x1=1, y1=0.05, style_name=stil)

    blocks = [
        block(0, "Rubrikname DMZ 2023", "Editorial"),
        block(1, "Inhalt Rubrik DMZ-Zeit 2018", "Soldatenporträt"),
        block(2, "Seitenrubrik", "Deutschland"),
        block(2, "Seitenrubrik", "Zweite auf derselben Seite"),
        block(3, "Mengentext", "Kein Rubrikblock"),
    ]
    assert seitenrubriken(blocks) == {0: "Editorial", 2: "Deutschland"}


def test_kopfzeilen_aus_der_textebene():
    from extractor.toc_layout import TextItem

    seiten = {
        2: [
            TextItem("Editorial", 0.42, 0.030, 0.58, 0.052, 20),
            TextItem("3", 0.93, 0.95, 0.95, 0.96, 10),
            TextItem("Verehrter Leser,", 0.1, 0.1, 0.3, 0.115, 11),
        ],
        5: [TextItem("Im", 0.1, 0.03, 0.12, 0.045, 13), TextItem("Visier", 0.13, 0.03, 0.2, 0.045, 13)],
        7: [TextItem("Nur Fliesstext weiter unten", 0.1, 0.2, 0.5, 0.215, 10)],
        # Die Schlagzeile ist groesser, aber die Kopfzeile steht darueber.
        9: [TextItem("ZULETZT", 0.1, 0.026, 0.2, 0.038, 12), TextItem("Im Kartoffelsack", 0.1, 0.056, 0.6, 0.1, 45)],
    }
    assert kopfzeilen(seiten) == {2: "Editorial", 5: "Im Visier", 9: "ZULETZT"}


def test_titel_bereinigen():
    # Die Kopfzeile der Seite zuerst — auch ohne Anrede im Text.
    assert titel_bereinigen("80 Jahre nach Bildung der SS-Kampfgruppe", aus_text=True, seitenrubrik="Editorial") == "Editorial"
    assert titel_bereinigen("Sehr geehrte Damen", aus_text=True, seitenrubrik="EDITORIAL") == "Editorial"
    # Rubrikname am Anfang gewinnt vor allem anderen; die Anrede nur zuletzt.
    assert titel_bereinigen("Impressum Schwerterträger Verlag", aus_text=False) == "Impressum"
    assert titel_bereinigen("Verehrter Leser, 80 Jahre nach Bildung", aus_text=True) == "Editorial"
    assert titel_bereinigen("Verehrter Leser, 80 Jahre nach Bildung", aus_text=True, seitenrubrik="Zuletzt") == "Zuletzt"
    # Ein Titel, der seine Rubrik selbst nennt, bleibt — auch unter fremder Kopfzeile.
    assert titel_bereinigen("Zu „Es ist die Migration“ in ZUERST! 2/2026", aus_text=True, seitenrubrik="BUCHBESPRECHUNGEN") == "Leserbriefe"
    assert titel_bereinigen("Die Kolumne", aus_text=False, seitenrubrik="KOLUMNE") == "Die Kolumne"
    # Aus dem Text: erst das Verzeichnis, dann die Seitenrubrik.
    assert titel_bereinigen(
        "Durch das, mit dem wir unseren Kopf füttern", aus_text=True,
        seitenrubrik="Deutschland", verzeichnis="Claus-M. Wolfschlag: Die Kolumne",
    ) == "Claus-M. Wolfschlag: Die Kolumne"
    # Eine Themenrubrik ist kein Titel.
    assert titel_bereinigen("Polen verleibte sich 1945", aus_text=True, seitenrubrik="Deutschland") == "Polen verleibte sich 1945"
    # Die Seitenrubrik nennt nur das Hauptstueck der Seite, nicht den Kasten darunter.
    assert titel_bereinigen(
        "Die Deutsche Militärzeitschrift ist unabhängig", aus_text=True,
        seitenrubrik="Editorial", erster_auf_seite=False,
    ) == "Die Deutsche Militärzeitschrift ist unabhängig"
    # Eine echte Ueberschrift bleibt, auch wenn das Verzeichnis die Rubrik nennt.
    assert titel_bereinigen(
        "Inquisition verbietet Buch des Kopernikus", aus_text=False, verzeichnis="Historischer Kalender"
    ) == "Inquisition verbietet Buch des Kopernikus"


def test_stehende_rubriken_kommen_ins_verzeichnis():
    def artikel(titel, seite):
        return AssembledArticle(
            title=titel,
            blocks=[SourceBlock(page_index=seite, text=titel, x0=0.1, y0=0.1, x1=0.9, y1=0.2)],
        )

    articles = [
        artikel("Editorial", 2),
        artikel("Historischer Kalender", 2),
        artikel("Schicksalsschlacht", 3),
        artikel("Zu „Im Panzerwahn“", 81),
        artikel("Impressum", 81),
    ]
    payload = [{"order": i + 1, "regions": []} for i in range(5)]
    hints = [
        TocHint("Schicksalsschlacht", 3, 1, 0.1, 0.1, 0.4, 0.2, printed=5),
        TocHint("Leserbriefe/Impressum", 81, 1, 0.1, 0.5, 0.4, 0.6, printed=82),
    ]
    entries = worker.Job._build_toc_entries(None, hints, articles, payload)
    # Das Impressum steht schon im gedruckten Eintrag seiner Seite.
    assert [(e["order"], e["label"], e["pageIndex"], e.get("articleOrder")) for e in entries] == [
        (1, "Editorial", 2, 1),
        (2, "Historischer Kalender", 2, 2),
        (3, "Schicksalsschlacht", 3, 3),
        (4, "Leserbriefe/Impressum", 81, 4),
    ]
    # Nur gedruckte Eintraege haben eine Klickflaeche.
    assert payload[2]["regions"] and payload[3]["regions"] and not payload[0]["regions"]


def test_meldungsrubrik_behaelt_ihren_ganzen_namen():
    assert titel_bereinigen("Nachrichten aus aller Welt", aus_text=False) == "Nachrichten aus aller Welt"


def test_kalenderblatt_ueber_die_doppelseite_bekommt_einen_strich():
    from extractor.model import TocHint
    from extractor.rubriken import verzeichnis_doppelseite

    hint = TocHint(label="Kalenderblatt Personen", page_index=63, toc_page_index=2, x0=0.1, y0=0.5, x1=0.4, y1=0.52)
    andere = TocHint(label="Arctic Convoy", page_index=65, toc_page_index=2, x0=0.1, y0=0.6, x1=0.4, y1=0.62)
    eins, rest = verzeichnis_doppelseite([hint, andere], {63: "Kalenderblatt", 64: "Personen", 65: "Film"})
    assert (eins.label, eins.page_index, eins.toc_page_index) == ("Kalenderblatt – Personen", 63, 2)
    assert rest is andere
