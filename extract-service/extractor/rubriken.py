"""Stehende Rubriken: Editorial, Impressum, Historischer Kalender und Co.

Eine stehende Rubrik hat im Satz oft keine Ueberschrift — das Editorial
beginnt mit "Verehrter Leser,", das Impressum mit "Impressum Deutsche
Militaerzeitschrift • Postfach …". Als Artikel hiesse sie nach ihrer ersten
Zeile. Sie soll aber nach ihrer Rubrik heissen, und sie soll im Verzeichnis
stehen, auch wenn das gedruckte sie nicht nennt.
"""

from __future__ import annotations

import re

from .idml_extract import VERZEICHNIS_STILE

STEHENDE_RUBRIKEN = (
    "Editorial",
    "Impressum",
    "Historischer Kalender",
    "Kalenderblatt",
    "Leserbriefe",
    "Buchbesprechungen",
    "Politikmeldungen",
    "Nachrichten",
    "Meldungen",
    "Die Kolumne",
    "Kolumne",
    "Vorschau",
    "Zuletzt",
)

# Die Anrede eines Editorials.
ANREDE = re.compile(
    r"^\s*(?:verehrte[rn]?|sehr geehrte[rn]?|liebe[rn]?|werte[rn]?)\s+leser", re.I
)
# Ein Leserbrief bezieht sich auf einen Artikel: "Zu „Im Panzerwahn“ in DMZ 169".
LESERBRIEF = re.compile(r"^\s*zu\s+[„\"»][^“\"«]{3,120}[“\"«]\s+in\s+", re.I)


def stehende_rubrik(text: str | None) -> str | None:
    """Die stehende Rubrik, mit der ein Text beginnt — in ihrer Schreibweise.

    "Verehrter Leser, kaum ist …" ist das Editorial, "Impressum Deutsche
    Militaerzeitschrift" das Impressum, "EDITORIAL" (Seitenrubrik) das
    Editorial.
    """
    if not text:
        return None
    t = " ".join(text.split())
    if ANREDE.match(t):
        return "Editorial"
    if LESERBRIEF.match(t):
        return "Leserbriefe"
    low = t.lower()
    for name in sorted(STEHENDE_RUBRIKEN, key=len, reverse=True):
        n = name.lower()
        if low == n or re.match(rf"^{re.escape(n)}(?=[\s:,.;!?/–-])", low):
            return name
    return None


def seitenrubriken(blocks) -> dict[int, str]:
    """Je Seite die Seitenrubrik aus dem Satz ("Editorial", "Deutschland").

    Bloecke mit "rubrik" im Absatzformat, kurz, und nicht die Rubrikzeilen
    des gedruckten Verzeichnisses. Die erste je Seite zaehlt.
    """
    out: dict[int, str] = {}
    for b in blocks:
        stil = (b.style_name or "").lower()
        if "rubrik" not in stil or any(h in stil for h in VERZEICHNIS_STILE):
            continue
        text = " ".join(b.text.split())
        if 2 <= len(text) <= 40 and b.page_index not in out:
            out[b.page_index] = text
    return out


def titel_bereinigen(
    titel: str,
    *,
    aus_text: bool,
    seitenrubrik: str | None = None,
    verzeichnis: str | None = None,
    erster_auf_seite: bool = True,
) -> str:
    """Der Titel eines Artikels; eine stehende Rubrik heisst nach ihrer Rubrik.

    1. Beginnt der Titel mit einer Anrede, einem Leserbrief-Bezug oder einem
       Rubriknamen, ist das der Titel ("Impressum Deutsche Militaerzeitschrift
       …" → "Impressum").
    2. Stammt der Titel aus dem Text (keine Ueberschrift im Satz): nennt das
       gedruckte Verzeichnis fuer die Seite eine stehende Rubrik, gilt dessen
       Eintrag ("Claus-M. Wolfschlag: Die Kolumne"); sonst, fuer den ersten
       Text der Seite, die Seitenrubrik, wenn sie eine stehende ist
       ("EDITORIAL" → "Editorial") — die Seitenrubrik nennt das Hauptstueck
       der Seite, nicht jeden Kasten darauf.
    3. Sonst bleibt der Titel.
    """
    eigene = stehende_rubrik(titel)
    if eigene:
        return eigene
    if not aus_text:
        return titel
    if verzeichnis and any(
        name.lower() in verzeichnis.lower() for name in STEHENDE_RUBRIKEN
    ):
        return " ".join(verzeichnis.split())
    aus_seite = stehende_rubrik(seitenrubrik) if erster_auf_seite else None
    if aus_seite:
        return aus_seite
    return titel
