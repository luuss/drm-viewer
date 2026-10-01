"""Anzeigenseiten und ihr Ziel im Laden — an den Umschlagtexten der Hefte."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.anzeige import (  # noqa: E402
    artikelnummern,
    ist_anzeige,
    reihe_der_sammlung,
    suchbegriffe,
)

SCHEIL = (
    "Der Historiker, für den nur Fakten zählen. Dr. Stefan Scheil. Polens "
    "Zwischenkrieg. Der Weg der Zweiten Republik von Versailles nach Gleiwitz. "
    "Stefan Scheil arbeitet detailliert heraus. 320 S., s/w. Abb., geb. im "
    "Großformat, € 29,80. Der Oberste Kriegsrat 1939/1940. Stefan Scheil/Robert "
    "Owen. 320 S., geb. im Großformat, € 29,80. DMZ-Versand Postfach 52"
)
WAFFEN_SS = (
    "Bücher zur Geschichte der Waffen‑SS. Besuchen Sie auch unsere Netzseite: "
    "www.lesenundschenken.de. „WIKING“ IM OSTEN. 200 S., viele s/w. Abb., geb. "
    "im Atlas-Großformat. – t 39,80. DIE EISERNE FAUST. 176 S. – t 29,80. "
    "Bestellungen an den Verlag."
)
SAMMLUNG = (
    "IHRE SAMMLUNG „BIBLIOTHEK DER TAPFERSTEN“. Heft 1: Art. 478003 Heft 7: "
    "Art. 478061 Heft 13: Art. 478133. Jedes Heft t 13,80. Bestellen Sie die "
    "Bibliothek der Tapfersten nach, der Schwerterträger erscheint viermal im Jahr."
)
EINZELN = "Das Ritterkreuz. 216 S., geb., € 24,80. Art. 101208. Jetzt bestellen."
AUSZEICHNUNGEN = (
    "Auszeichnungen von Generalfeldmarschall Robert Ritter von Greim. Eisernes "
    "Kreuz 2. Klasse (26. November 1914), Eisernes Kreuz 1. Klasse (11. Oktober "
    "1915), Pour le Mérite (14. Oktober 1918)."
)


def test_erkennt_anzeigen_an_preisen_und_bestellhinweisen():
    assert ist_anzeige(SCHEIL)
    assert ist_anzeige(WAFFEN_SS)
    assert ist_anzeige(SAMMLUNG)
    assert ist_anzeige(EINZELN)
    # Eine Liste von Orden ist keine Anzeige.
    assert not ist_anzeige(AUSZEICHNUNGEN)
    # Ein Preis neben der Verlagsanschrift reicht (Buchanzeige mit einem Titel).
    assert ist_anzeige("Ulrich Steinmetz: Zeugen deutscher Geschichte. Bildband, 32,80 Eur. "
                       "Orion-Heimreiter-Verlag Postfach 3667 D-24035 Kiel Tel. 04384/59700")
    assert not ist_anzeige("Der Artikel kostete den Steuerzahler 32,80 Eur je Kopf.")


def test_artikelnummern_und_sammlungen():
    assert artikelnummern(EINZELN) == ["101208"]
    assert artikelnummern(SAMMLUNG) == ["478003", "478061", "478133"]
    assert artikelnummern(SCHEIL) == []
    assert reihe_der_sammlung(SAMMLUNG) == "schwertertraeger"
    assert reihe_der_sammlung(SCHEIL) is None
    # Einmal genannt reicht, wenn Artikelnummern aufgelistet sind.
    assert reihe_der_sammlung("Ihre Sammlung Bibliothek der Tapfersten. Heft 1: Art. 478003 "
                              "Heft 2: Art. 478016 Heft 3: Art. 478029") == "schwertertraeger"


def test_suchbegriffe_vom_titel_ueber_den_verfasser_zu_den_woertern():
    assert suchbegriffe("Der Historiker, für den nur Fakten zählen", SCHEIL) == [
        "Stefan Scheil",
        "Der Historiker, für den nur Fakten zählen",
        "Fakten zählen",
        "Fakten",
    ]
    assert suchbegriffe("Bücher zur Geschichte der Waffen‑SS", WAFFEN_SS) == [
        "Bücher zur Geschichte der Waffen-SS",
        "Geschichte Waffen-SS",
        "Waffen-SS",
    ]
