"""Gedrucktes Inhaltsverzeichnis eines Hefts im Buch-Modus (Weltkrieg-Leser).

Im Buch-Modus ist ein Heft ein durchgehender Text (extractor/buch.py,
buch_pdf.py). Ein Verzeichnis bekommt es nur, wenn es selbst eines druckt.
Das WELTKRIEG-Magazin tut das: hinten im Heft steht eine Seite
"Inhaltsverzeichnis", je Beitrag eine Zeile "Titel . . . . . Seite", darueber
mitunter eine Rubrik oder Dachzeile mit Doppelpunkt ("Erlebnisbericht:").

Die Erzaehlhefte (Originalband, Doppelband, Soldaten, Grossband …) drucken
keines. Ihre grossen Zeilen sind Kapitelzeilen, Kartenbeschriftungen,
Bildzeilen und Kolumnentitel durcheinander und taugen nicht als Verzeichnis
(am 05.11.2026 an allen 436 Heften der Anlage nachgesehen). Dort bleibt es
beim einen Eintrag fuer den ganzen Text, und der Leser blendet das
Verzeichnis aus.

Beleg ist allein die Seite: eine Zeile "Inhalt" oder "Inhaltsverzeichnis"
und mindestens drei Zeilen, die mit einer Seitenzahl enden. Eine Seitenzahl
steht hinter einer Punktleiste oder mit grosser Luecke am rechten Rand
(manche Hefte drucken die Leiste nicht bei jedem Eintrag). Die gedruckte
Zahl fuehrt ueber die Seitenzahlen der Leserseiten (`printedLabel`) zum
Ziel; eine Zahl, die keine Leserseite traegt, gibt keinen Eintrag.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .model import TocHint
from .toc_layout import BUENDIG, RAND_X, RAND_Y, TextItem, _norm

# Kopfzeile der Seite: so nennt sich das Verzeichnis selbst.
KOPF = {"inhalt", "inhaltsverzeichnis"}
# Wenigstens so viele Zeilen mit Seitenzahl.
MIN_EINTRAEGE = 3
# Punkte, auch mit Abstaenden dazwischen; hinter einem langen Titel bleiben
# nur zwei (". . 78"). Ein einzelner Punkt ("Die 30. Infanterie-Division")
# oder eine Abkuerzung ("z.b.V.") ist keine Leiste.
PUNKTLEISTE = re.compile(r"\s*\.(?:\s*\.)+\s*")
LEISTE_AM_ENDE = re.compile(PUNKTLEISTE.pattern + r"$")
SEITENZAHL = re.compile(r"\d{1,3}")
# Leiste und Zahl im selben Stueck: "Generalmajor Karl-Lothar Schulz . . . 3".
LEISTE_UND_ZAHL = re.compile(r"^(.*?)" + PUNKTLEISTE.pattern + r"(\d{1,3})$")
# Ohne Leiste steht die Seitenzahl mit dieser Luecke (Anteil der
# Seitenbreite) hinter dem Titel am rechten Rand.
ZAHL_LUECKE = 0.1
# Eine Dachzeile steht direkt ueber ihrem Eintrag: die Luecke ist kleiner als
# dieser Anteil der Zeilenhoehe; zwischen zwei Eintraegen ist sie groesser.
DACH_LUECKE = 0.3
MAX_DACHZEILEN = 2
# pdf.js gibt eine Ligatur als eigenes Stueck ("Das En" | "fi" | "eld-Gewehr"),
# ebenso mancher Trennstrich ("in Bu" | "-"). Sonst stossen Stuecke auch dort
# buendig aneinander, wo ein Leerzeichen oder ein Bindestrich gedruckt ist,
# den die Textebene verliert ("Soltam" | "120"): dort bleibt der Abstand.
LIGATUREN = {"fi", "fl", "ff", "ffi", "ffl"}
BINDESTRICHE = {"-", "‐"}
WORTFUGE = 0.001


@dataclass
class _Zeile:
    items: list[TextItem]

    @property
    def x0(self) -> float:
        return min(i.x0 for i in self.items)

    @property
    def x1(self) -> float:
        return max(i.x1 for i in self.items)

    @property
    def y0(self) -> float:
        return min(i.y0 for i in self.items)

    @property
    def y1(self) -> float:
        return max(i.y1 for i in self.items)


def _zeilen(items: list[TextItem]) -> list[_Zeile]:
    """Stuecke einer Seite zu Zeilen: Mitte des einen in der Hoehe des anderen.

    Anders als `toc_layout.segments_of` bleiben Zahlen in ihrer Zeile ("F" |
    "35" | Leiste | "22"): hier ist die letzte Zahl der Zeile die Seitenzahl.
    Ein Stueck, viel hoeher als die Zeile (Zierbuchstabe am Rand), bildet
    seine eigene.
    """
    zeilen: list[list[TextItem]] = []
    for it in sorted(items, key=lambda i: (i.y0, i.x0)):
        if not it.text.strip():
            continue
        mitte = (it.y0 + it.y1) / 2
        hoehe = it.y1 - it.y0
        ziel = None
        for zeile in reversed(zeilen[-8:]):
            anker = zeile[0]
            anker_mitte = (anker.y0 + anker.y1) / 2
            anker_hoehe = anker.y1 - anker.y0
            if (
                anker.y0 <= mitte <= anker.y1
                and it.y0 <= anker_mitte <= it.y1
                and hoehe < 2 * anker_hoehe
                and anker_hoehe < 2 * hoehe
            ):
                ziel = zeile
                break
        if ziel is None:
            zeilen.append([it])
        else:
            ziel.append(it)
    out = [_Zeile(sorted(z, key=lambda i: i.x0)) for z in zeilen]
    out.sort(key=lambda z: (z.y0, z.x0))
    return out


def _text(items: list[TextItem]) -> str:
    """Text aus Stuecken; Ligatur und Bindestrich schliessen ohne Abstand an."""
    kleben = LIGATUREN | BINDESTRICHE
    out = ""
    vorher: TextItem | None = None
    for it in items:
        text = it.text.strip()
        if not text:
            continue
        if vorher is not None:
            buendig = it.x0 - vorher.x1 <= WORTFUGE
            if not (buendig and (text in kleben or vorher.text.strip() in kleben)):
                out += " "
        out += text
        vorher = it
    return out


def _eintrag(zeile: _Zeile) -> tuple[str, int, list[TextItem]] | None:
    """Titel, Seitenzahl und Stuecke einer Verzeichniszeile, sonst None."""
    letzte = zeile.items[-1]
    davor = zeile.items[:-1]
    text_letzte = letzte.text.strip()
    if SEITENZAHL.fullmatch(text_letzte) and davor:
        titel = _text(davor)
        leiste = LEISTE_AM_ENDE.search(titel)
        if leiste:
            titel = titel[: leiste.start()]
        elif letzte.x0 - davor[-1].x1 < ZAHL_LUECKE:
            # "Huzagol 35 M": eine Zahl im Titel, keine Seitenzahl.
            return None
        nummer = int(text_letzte)
    else:
        treffer = LEISTE_UND_ZAHL.match(_text(zeile.items))
        if not treffer:
            return None
        titel, nummer = treffer.group(1), int(treffer.group(2))
    titel = titel.strip()
    if not titel:
        return None
    return titel, nummer, zeile.items


def _leserseiten(pages: list[dict]) -> dict[int, int]:
    """Gedruckte Seitenzahl -> Leserseite."""
    out: dict[int, int] = {}
    for page in pages:
        label = str(page.get("printedLabel") or "").strip()
        if label.isdigit():
            out.setdefault(int(label), int(page["index"]))
    return out


def _dachzeilen(zeile: _Zeile, alle: list[_Zeile], eintraege: set[int]) -> list[_Zeile]:
    """Zeilen ohne Seitenzahl direkt ueber dem Eintrag, von oben nach unten."""
    out: list[_Zeile] = []
    unten = zeile
    for _ in range(MAX_DACHZEILEN):
        hoehe = unten.y1 - unten.y0
        oben = next(
            (
                z
                for z in reversed(alle)
                if id(z) not in eintraege
                and z.y1 <= unten.y0 + 0.1 * hoehe
                and unten.y0 - z.y1 <= DACH_LUECKE * hoehe
                and abs(z.x0 - unten.x0) <= BUENDIG
            ),
            None,
        )
        if oben is None:
            break
        out.insert(0, oben)
        unten = oben
    return out


def _anschluss(vorne: str, hinten: str) -> str:
    """Zwei Zeilen eines Titels: Trennung vor Kleinbuchstaben aufheben."""
    if vorne.endswith("-") and hinten[:1].islower() and vorne[-2:-1].isalpha():
        return vorne[:-1] + hinten
    return f"{vorne} {hinten}"


def _eintraege_der_seite(
    seite: int, items: list[TextItem], leserseite: dict[int, int]
) -> list[TocHint]:
    # Die grosse Ueberschrift fehlt manchem Heft in der Textebene (Magazin
    # 96); der Kolumnentitel "Inhalt" steht immer da, als eigenes Stueck.
    if not any(_norm(i.text) in KOPF for i in items):
        return []
    zeilen = _zeilen(items)
    gefunden = [(z, e) for z in zeilen if (e := _eintrag(z)) is not None]
    if len(gefunden) < MIN_EINTRAEGE:
        return []
    eintraege = {id(z) for z, _e in gefunden}
    out: list[TocHint] = []
    for zeile, (titel, nummer, teile) in gefunden:
        ziel = leserseite.get(nummer)
        if ziel is None or ziel == seite:
            continue
        # Ueber dem Eintrag: Rubrik oder Dachzeile ("Erlebnisbericht:") oder
        # der Anfang eines Titels ueber zwei Zeilen. Der Anfang ist es, wenn
        # die Zeile getrennt endet oder der Eintrag klein weitergeht ("Hölle
        # Stalingrad: Die 29. Infanterie-Division unter General Leyser" / "in
        # den letzten Kämpfen in Stalingrad-Mitte 1943").
        dach: list[str] = []
        flaeche = list(teile)
        for z in _dachzeilen(zeile, zeilen, eintraege):
            dach.append(_text(z.items))
            flaeche.extend(z.items)
        while dach and (dach[-1].endswith(("-", "–")) or titel[:1].islower()):
            titel = _anschluss(dach.pop(), titel)
        rubrik = " ".join(dach).strip().rstrip(":").strip() or None
        out.append(
            TocHint(
                label=titel,
                page_index=ziel,
                toc_page_index=seite,
                x0=max(0.0, min(t.x0 for t in flaeche) - RAND_X),
                y0=max(0.0, min(t.y0 for t in flaeche) - RAND_Y),
                x1=min(1.0, max(t.x1 for t in flaeche) + RAND_X),
                y1=min(1.0, max(t.y1 for t in flaeche) + RAND_Y),
                section=rubrik,
                printed=nummer,
            )
        )
    return out


def buch_verzeichnis(
    seiten: dict[int, list[TextItem]], pages: list[dict]
) -> list[TocHint]:
    """Die Eintraege des gedruckten Verzeichnisses, leer ohne eines.

    `seiten`: Textebene je Leserseite (`toc_layout.text_layer_for_pages`),
    `pages`: die Leserseiten des Auftrags mit `index` und `printedLabel`.
    """
    leserseite = _leserseiten(pages)
    if not leserseite:
        return []
    out: list[TocHint] = []
    for seite in sorted(seiten):
        out.extend(_eintraege_der_seite(seite, seiten[seite], leserseite))
    return out


def verzeichnisseiten(hints: list[TocHint]) -> set[int]:
    """Leserseiten, auf denen das Verzeichnis steht: kein Lesetext."""
    return {h.toc_page_index for h in hints if h.toc_page_index is not None}
