"""Klickflaechen fuer die Anreisser auf der Titelseite.

Die Titelseite (U1) wirbt mit Themen aus dem Heft: das Titelthema in grossen
Lettern, dazu Anreisser in einer Leiste ("Migrationswende-Luege / 2025 kamen
ueber 370.000 ...") oder schraeg ueber eine Ecke. Im Reader fuehrt ein Tipp
darauf zum Artikel, wie ein Eintrag im Inhaltsverzeichnis.

Der Satz der Titelseite liegt nicht vor, nur ihre Textebene (der Browser liest
sie beim Import aus dem Umschlag-PDF, gedrehten Satz eingeschlossen). Die
Anreisser nennen ihr Thema selten mit dem Titel des Artikels, aber mit seinen
Stichworten: "Gegenwind fuer Trump / ICE, Groenland, Inflation" gehoert zu
"Gefaehrliches Umfragetief / Das Auftreten der Einwanderungsbehoerde ICE
laesst Trumps Beliebtheitswerte einbrechen". Verglichen wird deshalb mit
Titel und Unterzeile der Verzeichniseintraege, gewichtet nach Seltenheit: ein
Wort, das nur ein Eintrag kennt, zaehlt viel, eines, das viele kennen, wenig.

Was nichts sicher trifft (Kopf, Preis, Strichcode, Bildunterschrift), bekommt
keine Flaeche. Lieber ein Anreisser ohne Link als einer, der woanders hinfuehrt.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

from .model import TocHint
from .toc_layout import Segment, TextItem, segments_of

# Zwei Zeilen gehoeren zu einem Anreisser, wenn die Luecke zwischen ihnen
# hoechstens diesen Anteil der hoeheren Zeile ausmacht.
BLOCKABSTAND = 0.9
# ... und die groessere Zeile hoechstens so viel hoeher ist als die kleinere.
HOEHENVERHAELTNIS = 2.0
# Mindestens so viele Stichworte muessen passen ...
MIN_TREFFER = 2
# ... mit diesem Gewicht zusammen, und der beste Eintrag muss den
# zweitbesten um diesen Faktor schlagen.
MIN_GEWICHT = 2.5
VORSPRUNG = 1.5
# Ein einzelnes Wort genuegt nur, wenn es lang ist und nur ein Eintrag es kennt.
EINZELWORT_LAENGE = 10
# Ein kuerzeres einzelnes Wort genuegt, wenn es genau so im Titel steht.
TITELWORT_LAENGE = 5
RAND = 0.006
# Zwischen zwei Feldern einer Anreisserleiste bleibt dieser Abstand frei.
FELDLUECKE = 0.008
# Zwei Woerter mit so vielen gleichen Anfangsbuchstaben haben denselben Stamm.
STAMM_LAENGE = 8
STAMM_ANTEIL = 0.75
# Bloecke mit mehr Zeilen werden nicht mehr in Anreisser aufgeteilt.
MAX_TEILZEILEN = 16

# Kopf und Rand der Titelseite: Preise, Jahrgang, Strichcode.
# Das Eurozeichen kommt aus manchen Schriften als anderer Buchstabe ("t 9,80"),
# deshalb zaehlt auch ein Betrag mit zwei Nachkommastellen und die Heftnummer.
PREIS = re.compile(
    r"€\s*\d|\d\s*€|\bCHF\b|\bEUR\b|\b\d{1,3},\d\d\b|\bNr\.\s*\d", re.IGNORECASE
)

STOPPWOERTER = {
    "aber", "alle", "also", "auch", "beim", "dass", "daß", "dem", "den", "der",
    "des", "die", "dies", "diese", "diesem", "diesen", "dieser", "dieses",
    "doch", "eine", "einem", "einen", "einer", "eines", "gegen", "hier",
    "ihre", "ihrem", "ihren", "ihrer", "immer", "jahr", "jahre", "jahren",
    "kein", "keine", "mehr", "nach", "neue", "neuen", "neuer", "nicht",
    "noch", "nur", "oder", "ohne", "sein", "seine", "seinem", "seinen",
    "seiner", "sich", "sind", "sowie", "über", "ueber", "uber", "unter",
    "viel", "viele", "vom", "von", "wird", "weiter", "wenn", "werden", "wie",
    "wieder", "will", "wurde", "zum", "zur", "zwischen", "heute", "jetzt",
    "gespräch", "gesprach", "zuerst",
}


@dataclass(frozen=True)
class Anreisser:
    """Eine Klickflaeche auf der Titelseite und die Seite, zu der sie fuehrt."""

    x0: float
    y0: float
    x1: float
    y1: float
    page_index: int
    label: str


@dataclass
class _Block:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    # Die Zeilen des Blocks in Lesefolge; ein Block kann mehrere Anreisser
    # tragen, die dicht untereinander stehen (`_aufteilen`).
    zeilen: list | None = None


def _verdoppelt(wort: str) -> str:
    """ "IInn" -> "In": Schatten- oder Konturschrift liefert jeden Buchstaben zweimal."""
    if len(wort) >= 4 and len(wort) % 2 == 0 and wort[0::2] == wort[1::2]:
        return wort[0::2]
    return wort


def stichworte(text: str) -> set[str]:
    """Vergleichswoerter: klein, ohne Satzzeichen, Zahlen ohne Tausenderpunkt."""
    text = unicodedata.normalize("NFKC", text).casefold()
    text = text.replace("­", "")
    text = re.sub(r"(?<=\d)[.,](?=\d)", "", text)
    woerter = re.findall(r"[^\W_]+", text)
    out = set()
    for w in woerter:
        w = _verdoppelt(w)
        if len(w) < 4 or w in STOPPWOERTER:
            continue
        out.add(w)
    return out


def _passt(wort: str, kandidat: str) -> bool:
    if wort == kandidat:
        return True
    # Beugung und Zusammensetzung: "trump" in "trumps", "grönland" in
    # "grönlandgelüste", "alliierte" in "westalliierten".
    if len(wort) >= 5 and (kandidat.startswith(wort) or wort.startswith(kandidat)):
        return min(len(wort), len(kandidat)) >= 5
    if len(wort) >= 6 and wort in kandidat:
        return True
    # Gleicher langer Wortstamm: "fernspäher" und "fernspähtruppe". Der
    # gemeinsame Anfang muss den groessten Teil des kuerzeren Wortes tragen,
    # sonst waeren "unterschrift" und "unterscharführer" verwandt.
    gemeinsam = _gemeinsamer_anfang(wort, kandidat)
    return gemeinsam >= STAMM_LAENGE and gemeinsam >= STAMM_ANTEIL * min(
        len(wort), len(kandidat)
    )


def _gemeinsamer_anfang(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def _ohne_dubletten(items: list[TextItem]) -> list[TextItem]:
    """Dieselbe Zeile zweimal an derselben Stelle (Schatten) zaehlt einmal."""
    gesehen = set()
    out = []
    for i in items:
        key = (i.text.strip(), round(i.x0, 3), round(i.y0, 3), round(i.x1, 3))
        if key in gesehen:
            continue
        gesehen.add(key)
        out.append(i)
    return out


def _ueberlappt_x(a: _Block, b) -> bool:
    return min(a.x1, b.x1) > max(a.x0, b.x0)


def _bloecke(items: list[TextItem]) -> list[_Block]:
    """Zeilen zu Anreissern buendeln; gedrehter Satz bildet eigene Bloecke."""
    gerade = [i for i in items if not i.winkel]
    # Senkrechter Satz am Rand sind Auslandspreise und Bildnachweise; ein
    # Anreisser steht schraeg ueber der Ecke.
    gedreht = [i for i in items if i.winkel and i.winkel % 90]
    zeilen: list[Segment] = sorted(segments_of(gerade), key=lambda s: (s.y0, s.x0))

    bloecke: list[_Block] = []
    for z in zeilen:
        hoehe = z.y1 - z.y0
        ziel = None
        for b in bloecke:
            luecke = z.y0 - b.y1
            letzte = b._letzte_hoehe  # type: ignore[attr-defined]
            # Das Titelthema in grossen Lettern steht oft dicht unter der
            # Leiste; Zeilen so verschiedener Groesse sind kein Anreisser.
            if (
                _ueberlappt_x(b, z)
                and max(hoehe, letzte) <= HOEHENVERHAELTNIS * min(hoehe, letzte)
                and -hoehe <= luecke <= BLOCKABSTAND * max(hoehe, letzte)
            ):
                ziel = b
                break
        if ziel is None:
            neu = _Block(z.x0, z.y0, z.x1, z.y1, z.text, [z])
            neu._letzte_hoehe = hoehe  # type: ignore[attr-defined]
            bloecke.append(neu)
            continue
        ziel.x0 = min(ziel.x0, z.x0)
        ziel.x1 = max(ziel.x1, z.x1)
        ziel.y1 = max(ziel.y1, z.y1)
        ziel.text += " " + z.text
        ziel.zeilen.append(z)  # type: ignore[union-attr]
        ziel._letzte_hoehe = hoehe  # type: ignore[attr-defined]

    # Schraeger Satz: Stuecke, deren Rechtecke sich beruehren, sind ein Band.
    baender: list[_Block] = []
    for i in gedreht:
        band = next(
            (
                b
                for b in baender
                if _ueberlappt_x(b, i) and min(b.y1, i.y1) > max(b.y0, i.y0)
            ),
            None,
        )
        if band is None:
            baender.append(_Block(i.x0, i.y0, i.x1, i.y1, i.text))
            continue
        band.x0, band.y0 = min(band.x0, i.x0), min(band.y0, i.y0)
        band.x1, band.y1 = max(band.x1, i.x1), max(band.y1, i.y1)
        band.text += " " + i.text
    return bloecke + baender


def _kandidaten(hints: list[TocHint]) -> dict[int, set[str]]:
    """Je Zielseite die Stichworte aller Eintraege, die dorthin fuehren."""
    out: dict[int, set[str]] = {}
    for h in hints:
        if h.page_index is None:
            continue
        out.setdefault(h.page_index, set()).update(
            stichworte(f"{h.label} {h.details or ''}")
        )
    return out


def _titelworte(hints: list[TocHint]) -> dict[int, set[str]]:
    """Je Zielseite die Stichworte der Titel allein (ohne Unterzeile)."""
    out: dict[int, set[str]] = {}
    for h in hints:
        if h.page_index is not None:
            out.setdefault(h.page_index, set()).update(stichworte(h.label))
    return out


def _bewerten(
    worte: set[str], kandidaten: dict[int, set[str]]
) -> list[tuple[float, int, int, list[str]]]:
    n = len(kandidaten)
    df: dict[str, int] = {}
    treffer_je: dict[int, list[str]] = {}
    for wort in worte:
        seiten = [s for s, ks in kandidaten.items() if any(_passt(wort, k) for k in ks)]
        df[wort] = len(seiten)
        for s in seiten:
            treffer_je.setdefault(s, []).append(wort)
    wertung = []
    for seite, treffer in treffer_je.items():
        gewicht = sum(math.log((n + 1) / df[w]) for w in treffer)
        wertung.append((gewicht, seite, len(treffer), treffer))
    wertung.sort(reverse=True)
    return wertung, df  # type: ignore[return-value]


def _sicher(wertung, df) -> tuple[int, list[str]] | None:
    if not wertung:
        return None
    gewicht, seite, anzahl, treffer = wertung[0]
    zweiter = wertung[1][0] if len(wertung) > 1 else 0.0
    if gewicht < VORSPRUNG * zweiter:
        return None
    if anzahl >= MIN_TREFFER and gewicht >= MIN_GEWICHT:
        return seite, treffer
    if anzahl == 1 and len(treffer[0]) >= EINZELWORT_LAENGE and df[treffer[0]] == 1:
        return seite, treffer
    return None


def _ziel(
    text: str, kandidaten: dict[int, set[str]], titel: dict[int, set[str]] | None = None
) -> int | None:
    """Die Zielseite eines Textes, wenn er sicher einem Eintrag gehoert.

    Ausser den Regeln in `_sicher` genuegt ein einzelnes Wort, wenn es genau so
    im Titel eines einzigen Eintrags steht und der Text sonst nur Zahlen hat:
    das Titelthema "Mscha 1943" gehoert zu "Vorstoss ueber den Mscha".
    """
    worte = stichworte(text)
    if not worte or PREIS.search(text):
        return None
    wertung, df = _bewerten(worte, kandidaten)
    sicher = _sicher(wertung, df)
    if sicher:
        return sicher[0]
    if titel and len(wertung) == 1 and wertung[0][2] == 1:
        _gewicht, seite, _anzahl, (wort,) = wertung[0]
        bedeutend = [w for w in worte if not w.isdigit()]
        if (
            bedeutend == [wort]
            and df[wort] == 1
            and len(wort) >= TITELWORT_LAENGE
            and wort in titel.get(seite, set())
        ):
            return seite
    return None


def _aufteilen(
    block: _Block, kandidaten: dict[int, set[str]], titel: dict[int, set[str]] | None = None
) -> list[tuple[_Block, int]]:
    """Einen Block in die Anreisser zerlegen, die er traegt.

    Drei Anreisser gleicher Schrift dicht untereinander (DMZ: "Italiens
    Panzerjaeger / Centauro / ...", darunter "Aristokrat mit dem Eichenlaub /
    Diplomat und General / ...") bilden einen Block; als Ganzes gewaenne der
    Anreisser mit den meisten Stichworten, die anderen fuehrten mit zu ihm.
    Gesucht wird die Zerlegung in aufeinanderfolgende Zeilengruppen mit den
    meisten sicheren Treffern; bei Gleichstand die, deren Treffer mehr Zeilen
    abdecken, dann die mit weniger Gruppen. Der ganze Block ist eine der
    Zerlegungen, er bleibt also, wenn Teilen nichts bringt. Benachbarte
    Gruppen mit demselben Ziel sind ein Anreisser. Eine Zeile mit Preis (der
    Kopf, wenn er dicht ueber dem Anreisser steht) bekommt nie eine Flaeche.
    """
    zeilen = block.zeilen or []
    if len(zeilen) < 2 or len(zeilen) > MAX_TEILZEILEN:
        ziel = _ziel(block.text, kandidaten, titel)
        return [(block, ziel)] if ziel is not None else []
    n = len(zeilen)
    ziele: dict[tuple[int, int], int | None] = {}
    for i in range(n):
        for j in range(i + 1, n + 1):
            ziele[(i, j)] = _ziel(" ".join(z.text for z in zeilen[i:j]), kandidaten, titel)
    def luecke(i: int) -> float:
        """Abstand vor Zeile i: zwischen zwei Anreissern ist er groesser."""
        return max(0.0, zeilen[i].y0 - zeilen[i - 1].y1) if i > 0 else 0.0

    # beste[j]: (Treffer, abgedeckte Zeilen, -Gruppen, Luecken an den
    # Schnitten), Gruppen bis Zeile j
    beste: list = [((0, 0, 0, 0.0), [])]
    for j in range(1, n + 1):
        kandidat = None
        for i in range(j):
            (treffer, deckung, gruppen, schnitte), teile = beste[i]
            z = ziele[(i, j)]
            wert = (
                treffer + (z is not None),
                deckung + ((j - i) if z is not None else 0),
                gruppen - 1,
                schnitte + luecke(i),
            )
            if kandidat is None or wert > kandidat[0]:
                kandidat = (wert, teile + [(i, j)])
        beste.append(kandidat)  # type: ignore[arg-type]
    gruppen: list[tuple[int, int, int]] = []
    for i, j in beste[n][1]:
        z = ziele[(i, j)]
        if z is None:
            continue
        if gruppen and gruppen[-1][1] == i and gruppen[-1][2] == z:
            gruppen[-1] = (gruppen[-1][0], j, z)
        else:
            gruppen.append((i, j, z))
    out = []
    for i, j, z in gruppen:
        teil = zeilen[i:j]
        out.append(
            (
                _Block(
                    min(s.x0 for s in teil),
                    min(s.y0 for s in teil),
                    max(s.x1 for s in teil),
                    max(s.y1 for s in teil),
                    " ".join(s.text for s in teil),
                    list(teil),
                ),
                z,
            )
        )
    return out


def _stapel_trennen(flaechen: list[_Block]) -> None:
    """Untereinanderstehende Anreisser teilen sich die Luecke.

    Der Rand um die Zeilen reicht bei dicht gestapelten Anreissern in den
    naechsten; die obere Flaeche endet und die untere beginnt dann in der
    Mitte der Ueberlappung.
    """
    for oben in flaechen:
        for unten in flaechen:
            if oben is unten or not _ueberlappt_x(oben, unten) or unten.y0 <= oben.y0:
                continue
            ueber = oben.y1 - unten.y0
            if 0 < ueber <= 0.5 * min(oben.y1 - oben.y0, unten.y1 - unten.y0):
                mitte = (oben.y1 + unten.y0) / 2
                oben.y1 = unten.y0 = mitte


def _felder_aufziehen(flaechen: list[_Block]) -> None:
    """Felder einer Anreisserleiste auf ihre ganze Zelle ziehen.

    In der Leiste steht neben jedem Text sein Bild. Liegen mehrere Anreisser
    nebeneinander, reicht jede Flaeche bis kurz vor den naechsten, die letzte
    so weit nach rechts, wie die erste links Rand laesst; alle bekommen die
    Hoehe der hoechsten.
    """
    reihen: list[list[_Block]] = []
    for f in sorted(flaechen, key=lambda f: f.x0):
        reihe = next(
            (
                r
                for r in reihen
                if any(min(f.y1, g.y1) - max(f.y0, g.y0) > 0.5 * (f.y1 - f.y0) for g in r)
            ),
            None,
        )
        if reihe is None:
            reihen.append([f])
        else:
            reihe.append(f)
    for reihe in reihen:
        if len(reihe) < 2:
            continue
        reihe.sort(key=lambda f: f.x0)
        y0 = min(f.y0 for f in reihe)
        y1 = max(f.y1 for f in reihe)
        links = reihe[0].x0
        for f, naechste in zip(reihe, reihe[1:] + [None]):
            f.y0, f.y1 = y0, y1
            if naechste is not None:
                f.x1 = max(f.x1, naechste.x0 - FELDLUECKE)
            else:
                f.x1 = max(f.x1, 1.0 - links)


def titel_anreisser(items: list[TextItem], hints: list[TocHint]) -> list[Anreisser]:
    """Die Anreisser der Titelseite, die sicher einem Verzeichniseintrag gehoeren."""
    kandidaten = _kandidaten(hints)
    titel = _titelworte(hints)
    if not items or not kandidaten:
        return []
    gefunden: list[tuple[_Block, int]] = []
    for ganzer in _bloecke(_ohne_dubletten(items)):
        for block, seite in _aufteilen(ganzer, kandidaten, titel):
            flaeche = _Block(
                max(0.0, block.x0 - RAND),
                max(0.0, block.y0 - RAND),
                min(1.0, block.x1 + RAND),
                min(1.0, block.y1 + RAND),
                block.text,
            )
            gefunden.append((flaeche, seite))
    _felder_aufziehen([f for f, _ in gefunden])
    _stapel_trennen([f for f, _ in gefunden])
    return [
        Anreisser(
            round(f.x0, 5),
            round(f.y0, 5),
            round(min(1.0, f.x1), 5),
            round(f.y1, 5),
            seite,
            " ".join(_verdoppelt(w) for w in f.text.split())[:300],
        )
        for f, seite in gefunden
    ]
