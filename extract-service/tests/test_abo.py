"""Abo-Aufrufe: erkannt an den echten Umschlagtexten der vier Reihen."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.abo import abo_aufruf  # noqa: E402

DMZ_ABO = (
    "Feuer Frei! Die DMZ im Abo nach hause holen! Im Zeitschriften- und im "
    "Bahnhofsbuchhandel finden Sie die aktuelle Ausgabe der Deutschen "
    "Militärzeitschrift (DMZ). Noch besser: Mit Ihrem Abonnement stärken Sie die "
    "DMZ. Abonnieren sie Jetzt und Sichern sie sich eine Tolle Prämie. Ja, ich "
    "möchte ein preisgünstiges Abonnement. Verlag Deutsche Militärzeitschrift "
    "(VDMZ) • Postfach 52 • D-24236 Selent"
)
ZEITGESCHICHTE_ABO = (
    "Fachzeitschrift über die Waffen-SS. Alles Wissenswerte finden Sie alle 2 "
    "Monate in dmz Z EitgEschichtE. Wenn Sie noch heute eine Abonnement-Bestellung "
    "tätigen, werden Sie dmz eitgeschichte künftig frei Haus erhalten. Ja, ich "
    "möchte DMZ EITGESCHICHTE abonnieren. Abo-Bestellung per Fax. Verlag Deutsche "
    "Militärzeitschrift (VDMZ) • Postfach 52"
)
ZUERST_ABO = (
    "Jeden Monat neu im Zeitschriften- und im Bahnhofsbuchhandel im Umfang von 84 "
    "Seiten. Aber wirklich stark nur durch Ihr Abonnement! Handeln Sie jetzt: "
    "Abonnement, Geschenkabonnement, Leserwerbung! Bei Abonnement bis zum 31.3.2026 "
    "gibt es das Buch „Zeugen deutscher Geschichte“. Kombi-Abo (bei gleichzeitigem "
    "Abo der Deutschen Militärzeitschrift (DMZ), siehe Umschlag hinten): t 96,– "
    "E-Post: verlag@zuerst.de. Verlag Deutsche Militärzeitschrift (VDMZ) Postfach 52"
)
TAPFERSTEN_ABO = (
    "VIERMAL IM JAHR! Die Bibliothek der Tapfersten im Abo nach hause holen! "
    "Abonnieren Sie den Schwerterträger. Ja, ich möchte die Bibliothek der "
    "Tapfersten abonnieren. Abo-Bestellung"
)
IMPRESSUM = (
    "Impressum Deutsche Militärzeitschrift (DMZ) • Selent. Abonnement: Inland "
    "58,80 €, Ausland 75,– €. Abonnenten erhalten die Hefte frei Haus. "
    "Abo-Bestellungen an den Verlag."
)
BUCHANZEIGE = (
    "Der Historiker, für den nur Fakten zählen. Stefan Scheil: Polens "
    "Zwischenkrieg. 320 S., geb. im Großformat, € 29,80. DMZ-Versand, Postfach 52."
)


def test_erkennt_die_beworbene_reihe():
    assert abo_aufruf(DMZ_ABO, "Feuer Frei!", eigene_reihe="zuerst") == "dmz"
    assert abo_aufruf(ZEITGESCHICHTE_ABO, "Fachzeitschrift", eigene_reihe="dmz") == "dmz-zeitgeschichte"
    assert abo_aufruf(TAPFERSTEN_ABO, "", eigene_reihe="schwertertraeger") == "schwertertraeger"


def test_schwacher_befund_faellt_auf_die_eigene_reihe():
    # Der ZUERST!-Aufruf nennt den Titel nur in der Anschrift; das Kombi-Abo
    # nennt die DMZ einmal, und die Verlagsanschrift wirbt fuer niemanden.
    assert abo_aufruf(ZUERST_ABO, "", eigene_reihe="zuerst") == "zuerst"
    # In der DMZ waere derselbe Text ein Aufruf fuer die DMZ.
    assert abo_aufruf(ZUERST_ABO, "", eigene_reihe="dmz") == "dmz"
    # "DMZ ZEITGESCHICHTE" ist keine DMZ-Nennung, auch nicht aus Kapitaelchen.
    assert abo_aufruf(ZEITGESCHICHTE_ABO, "", eigene_reihe="zuerst") == "dmz-zeitgeschichte"


def test_impressum_und_buchanzeige_sind_keine_aufrufe():
    assert abo_aufruf(IMPRESSUM, "Impressum", eigene_reihe="dmz") is None
    assert abo_aufruf(BUCHANZEIGE, "Der Historiker", eigene_reihe="dmz") is None
    # Ein langer Artikel, der das Abo nur erwaehnt, bleibt ein Artikel.
    lang = ("Abo " * 4) + ("Text. " * 800)
    assert abo_aufruf(lang, "", eigene_reihe="dmz", max_zeichen=3000) is None
    assert abo_aufruf(lang, "", eigene_reihe="dmz") == "dmz"
