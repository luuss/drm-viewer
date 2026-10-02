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
    "Nachruf",
    "Nachrufe",
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


def stehende_rubrik(text: str | None, *, mit_anrede: bool = True) -> str | None:
    """Die stehende Rubrik, mit der ein Text beginnt — in ihrer Schreibweise.

    "Impressum Deutsche Militaerzeitschrift" ist das Impressum, "EDITORIAL"
    (Kopfzeile) das Editorial, "Zu „…“ in DMZ 169" ein Leserbrief. Die Anrede
    ("Verehrter Leser") zaehlt nur, wenn `mit_anrede` gesetzt ist — sie ist
    ein schwaches Zeichen, auf das man sich nicht verlassen soll.
    """
    if not text:
        return None
    t = " ".join(text.split())
    if mit_anrede and ANREDE.match(t):
        return "Editorial"
    if LESERBRIEF.match(t):
        return "Leserbriefe"
    low = t.lower()
    for name in sorted(STEHENDE_RUBRIKEN, key=len, reverse=True):
        n = name.lower()
        if low == n or re.match(rf"^{re.escape(n)}(?=[\s:,.;!?/–-])", low):
            return name
    return None


def kopfzeilen(text_by_page, max_y: float = 0.06) -> dict[int, str]:
    """Je Seite die Kopfzeile aus der Textebene: die oberste kurze Zeile.

    Der Satz legt Kopfzeilen oft auf die Musterseite, dann fehlen sie in der
    IDML; die Textebene der gedruckten Seite hat sie ("Editorial" oben auf
    Seite 3 der DMZ-Zeitgeschichte). Genommen wird die oberste Zeile im
    obersten Sechzehntel, ohne Seitenzahlen — eine Schlagzeile steht tiefer
    und ist groesser, aber nicht die Kopfzeile.
    """
    out: dict[int, str] = {}
    for page, items in text_by_page.items():
        oben = [
            i
            for i in items
            if i.y0 < max_y and 2 <= len(i.text.strip()) <= 40 and not i.text.strip().isdigit()
        ]
        if not oben:
            continue
        beste = min(oben, key=lambda i: (round(i.y0, 3), -i.size))
        zeile = sorted((i for i in oben if abs(i.y0 - beste.y0) < 0.004), key=lambda i: i.x0)
        text = " ".join(i.text.strip() for i in zeile)
        if 2 <= len(text) <= 40:
            out[page] = text
    return out


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

    1. Beginnt der Titel mit einem Rubriknamen oder einem Leserbrief-Bezug,
       ist das der Titel ("Impressum Deutsche Militaerzeitschrift …" →
       "Impressum").
    2. Die Kopfzeile der Seite ("Editorial", "EDITORIAL"), wenn sie eine
       stehende Rubrik nennt und der Artikel das Hauptstueck der Seite ist
       (der erste darauf) und keine eigene Ueberschrift hat.
    3. Stammt der Titel aus dem Text: nennt das gedruckte Verzeichnis fuer
       die Seite eine stehende Rubrik, gilt dessen Eintrag ("Claus-M.
       Wolfschlag: Die Kolumne").
    4. Zuletzt die Anrede ("Verehrter Leser" → "Editorial"); sonst bleibt der
       Titel.
    """
    eigene = stehende_rubrik(titel, mit_anrede=False)
    # Die Kopfzeile der Seite ist das verlaessliche Zeichen: steht oben
    # "Editorial", ist das Hauptstueck der Seite das Editorial — sofern es
    # keine eigene Ueberschrift hat oder selbst mit der Rubrik beginnt.
    aus_seite = (
        stehende_rubrik(seitenrubrik, mit_anrede=False) if erster_auf_seite else None
    )
    if eigene and not aus_text and eigene.lower() in ("nachrichten", "meldungen"):
        # Eine gesetzte Rubrikzeile ist schon der Name: "Nachrichten aus
        # Deutschland" und "Nachrichten aus aller Welt" sind zwei Rubriken.
        return titel
    if eigene:
        # Der Titel nennt seine Rubrik selbst ("Leserbriefe" unter der
        # Kopfzeile "Buchbesprechungen" der Nachbarseite).
        return eigene
    if aus_seite and aus_text:
        return aus_seite
    if not aus_text:
        return titel
    if verzeichnis and any(
        name.lower() in verzeichnis.lower() for name in STEHENDE_RUBRIKEN
    ):
        return " ".join(verzeichnis.split())
    # Zuletzt die Anrede — nur, wenn nichts anderes die Seite benennt.
    return stehende_rubrik(titel) or titel


def verzeichnis_teilen(hints: list, rubriken: dict[int, str]) -> list:
    """Einen Verzeichniseintrag ueber eine Doppelseite in seine zwei Rubriken teilen.

    Das Kalenderblatt der DMZ steht links unter "Kalenderblatt", rechts unter
    "Personen" (oder "Ereignisse"); das gedruckte Verzeichnis nennt beides als
    eine Zeile, "Kalenderblatt Personen". Im Leser sind es zwei Eintraege,
    jeder auf seiner Seite. Geteilt wird nur, wenn die Zeile genau aus den
    Kopfzeilen der Seite und ihrer Folgeseite besteht.
    """
    from dataclasses import replace

    def wie(text: str) -> str:
        return " ".join(text.split()).casefold()

    out = []
    for h in hints:
        links = rubriken.get(h.page_index)
        rechts = rubriken.get(h.page_index + 1)
        if (
            links
            and rechts
            and wie(links) != wie(rechts)
            and wie(h.label) == wie(f"{links} {rechts}")
        ):
            out.append(replace(h, label=" ".join(links.split())))
            # Die Folgeseite hat keine eigene Zeile im gedruckten Verzeichnis
            # und deshalb keine Klickflaeche dort.
            out.append(replace(h, label=" ".join(rechts.split()), page_index=h.page_index + 1, toc_page_index=None))
        else:
            out.append(h)
    return out
