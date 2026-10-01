"""Anzeigenseiten erkennen und ihr Ziel im Laden bestimmen.

Eine Umschlagtafel, die Buecher oder Hefte anpreist, wird kein Artikel: im
Seitenmodus fuehrt ein Tipp darauf in den Laden. Wohin, haengt von der
Anzeige ab:

* genau eine Artikelnummer ("Art. 101208") — das Produkt selbst;
* eine Sammlung von Heften einer Reihe — die Kategorie der Reihe;
* sonst eine Suche im Laden, mit Suchbegriffen aus Titel und Text (der
  Verfasser, wenn er mehrfach genannt wird, dann die Titelzeile).

Hier steht nur das Erkennen und Vorschlagen; was der Laden zu den Begriffen
findet, entscheidet das Backend (convex/pageLinks.ts, `resolveInternal`).
"""

from __future__ import annotations

import re
from collections import Counter

from .abo import REIHEN

# Was eine Anzeige verraet: Preise, Artikel- oder Bestellnummern, Bestellhinweise.
_MARKER = re.compile(
    r"(?:€|EUR|(?<![A-Za-zÄÖÜäöüß])t)\s?\d{1,3}(?:\.\d{3})*,(?:\d{2}|[–—-])"
    r"|\d{1,3}(?:\.\d{3})*,(?:\d{2}|[–—-])\s?(?:€|EUR)"
    r"|\bArt(?:ikel)?\.?\s*(?:-?\s*Nr\.?)?\s*\d{5,6}\b"
    r"|\bBest(?:ell)?\.?\s*-?\s*Nr\.?\s*\d{4,6}\b"
    r"|\bbestell\w*|\bISBN\b|lesenundschenken\.de|\bVersand\b",
    re.I,
)
# "Art. 101208", "Art.-Nr. 101208", "Best.-Nr. 478003".
_REFERENZ = re.compile(
    r"\b(?:Art(?:ikel)?\.?\s*(?:-?\s*Nr\.?)?|Best(?:ell)?\.?\s*-?\s*Nr\.?)\s*:?\s*(\d{5,6})\b",
    re.I,
)
# Zwei grossgeschriebene Woerter hintereinander: ein Name, wenn er sich wiederholt.
_NAME = re.compile(r"\b([A-ZÄÖÜ][a-zäöüß]{2,})\s+([A-ZÄÖÜ][a-zäöüß]{2,})\b")
_FUELLWOERTER = {
    "Der", "Die", "Das", "Den", "Dem", "Des", "Ein", "Eine", "Und", "Mit",
    "Von", "Vom", "Zum", "Zur", "Aus", "Bei", "Nach", "Ueber", "Über", "Für",
    "Jetzt", "Neu", "Alle", "Band", "Heft", "Seite", "Seiten", "Preis",
}


_PREIS = re.compile(
    r"(?:€|EUR|(?<![A-Za-zÄÖÜäöüß])t)\s?\d{1,3}(?:\.\d{3})*,(?:\d{2}|[–—-])"
    r"|\d{1,3}(?:\.\d{3})*,(?:\d{2}|[–—-])\s?(?:€|EUR)",
    re.I,
)
_KONTAKT = re.compile(r"\bPostfach\b|\bVerlag\b|\bTel\.?\s*:?\s*\d|\bFax\b|\bISBN\b", re.I)


def ist_anzeige(text: str, min_marker: int = 2) -> bool:
    """Preist der Text etwas zum Kauf an?

    Zwei Hinweise reichen — oder ein Preis neben Verlagsanschrift, Telefon
    oder ISBN (eine Buchanzeige mit einem einzigen Titel nennt den Preis nur
    einmal).
    """
    if len(_MARKER.findall(text)) >= min_marker:
        return True
    return bool(_PREIS.search(text)) and bool(_KONTAKT.search(text))


def artikelnummern(text: str) -> list[str]:
    """Alle verschiedenen Artikelnummern im Text, in Reihenfolge."""
    gesehen: list[str] = []
    for m in _REFERENZ.finditer(text):
        if m.group(1) not in gesehen:
            gesehen.append(m.group(1))
    return gesehen


def reihe_der_sammlung(text: str, min_nennungen: int = 3) -> str | None:
    """Die Reihe, deren Hefte die Anzeige sammelt.

    Mehrfach genannt — oder einmal genannt neben einer Liste von
    Artikelnummern ("Heft 1: Art. 478003, Heft 2: Art. 478016 …").
    """
    punkte = {slug: len(rx.findall(text)) for slug, rx in REIHEN}
    beste = max(punkte, key=lambda s: punkte[s])
    if punkte[beste] >= min_nennungen:
        return beste
    if punkte[beste] >= 1 and len(artikelnummern(text)) >= 3:
        return beste
    return None


def _verfasser(text: str, titel: str) -> str | None:
    zaehler: Counter[str] = Counter()
    for a, b in _NAME.findall(text):
        if a in _FUELLWOERTER or b in _FUELLWOERTER:
            continue
        zaehler[f"{a} {b}"] += 1
    for name, n in zaehler.most_common():
        if n >= 2 and name.lower() not in titel.lower():
            return name
    return None


def _bedeutsame_woerter(titel: str) -> list[str]:
    woerter = [w.strip("„“\"',.:;!?()") for w in titel.replace("‑", "-").split()]
    return [w for w in woerter if len(w) >= 5 and w.capitalize() not in _FUELLWOERTER]


def suchbegriffe(titel: str, text: str) -> list[str]:
    """Suchbegriffe fuer den Laden, der treffendste zuerst.

    Der mehrfach genannte Verfasser (eine Anzeige mit mehreren seiner
    Buecher), dann die Titelzeile ganz, dann die tragenden Woerter des Titels,
    zuletzt das letzte grossgeschriebene davon (das Thema steht am Ende:
    "Buecher zur Geschichte der Waffen-SS") — bis zu vier Begriffe. Das
    Backend nimmt ein einzelnes Produkt, wo ein Begriff genau eines trifft,
    sonst die Suchseite des ersten Begriffs mit Treffern.
    """
    out: list[str] = []
    sauber = " ".join(titel.replace("\u2011", "-").split()).strip(" ,.:;!?")
    name = _verfasser(text, titel)
    if name:
        out.append(name)
    if sauber:
        out.append(sauber[:80])
    woerter = _bedeutsame_woerter(sauber)
    if len(woerter) >= 2:
        out.append(" ".join(woerter[-2:]))
    gross = [w for w in woerter if w[:1].isupper()]
    if gross:
        out.append(gross[-1])
    elif woerter:
        out.append(woerter[-1])
    gesehen: list[str] = []
    for q in out:
        if q.lower() not in (g.lower() for g in gesehen):
            gesehen.append(q)
    return gesehen[:4]
