"""Schnittmarken in einer gerenderten Druckseite finden.

Druck-PDFs tragen rings um das Netzformat Anschnitt und Schnittmarken. Der
Browser schneidet beim Import auf das Netzformat, wenn er es kennt (Satzdatei,
TrimBox). Am 05.11.2026 lagen 300 Weltkrieg-Hefte mit Marken im Leser: ohne
IDML war kein Netzformat bekannt, die Seite kam mit gut 10 mm Rand und den
Marken in den Ecken (Verhaeltnis 0,727 statt 0,707).

Erkannt wird das Bild selbst, nicht eine Annahme ueber das Format: in jeder
der vier Ecken eine senkrechte und eine waagrechte duenne Linie im aeusseren
Rand, auf hellem Grund. Die Linien liegen auf den Schnittkanten. Gilt nur,
wenn alle acht Linien da sind, oben und unten bzw. links und rechts auf
derselben Linie liegen, der Rand symmetrisch ist und die Ecken aussen leer
sind (kein Bild, das bis an den Rand laeuft). Sonst: kein Schnitt.
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

# Grauwert, unter dem ein Bildpunkt zur Linie zaehlt.
DUNKEL = 110
# Breite des Randstreifens, in dem die Marken gemessen werden (Anteil der
# Seite). Die Marken beginnen am Seitenrand und enden vor dem Anschnitt.
STREIFEN = 0.018
# Die Marken liegen im aeusseren Achtel der Seite.
SUCHE = 0.12
# Eine Spalte (Zeile) ist Linie, wenn sie im Streifen so dicht dunkel ist ...
LINIE_DICHT = 0.7
# ... und ihre Nachbarn so hell sind.
UMGEBUNG_HELL = 0.08
UMGEBUNG = 3
# Linienstaerke hoechstens (Anteil der Seitenbreite, mindestens 4 Punkte).
MAX_DICKE = 0.004
# Oben und unten (links und rechts) duerfen die Linien so weit auseinander
# liegen, und so ungleich darf der Rand sein (Anteil der Seite).
GLEICH = 0.004
SYMMETRIE = 0.01
# Aussen in der Ecke (aeussere Haelfte des Randes) hoechstens so viel Dunkles.
ECKE = 0.5
ECKE_DUNKEL = 0.01
# So viele der acht Marken muessen auf den Kanten stehen, wenn eine Seite den
# Schnitt der anderen Seiten des Hefts uebernimmt (`marken_passen`).
MARKEN_MINDESTENS = 5


@dataclass(frozen=True)
class Schnitt:
    """Das Netzformat im Bild, in Bildpunkten (rechts und unten exklusiv)."""

    links: int
    oben: int
    rechts: int
    unten: int
    breite: int
    hoehe: int

    @property
    def box(self) -> tuple[int, int, int, int]:
        return (self.links, self.oben, self.rechts, self.unten)

    @property
    def anteile(self) -> tuple[float, float, float, float]:
        """Der Schnitt als Anteile der alten Seite (x0, y0, x1, y1)."""
        return (
            self.links / self.breite,
            self.oben / self.hoehe,
            self.rechts / self.breite,
            self.unten / self.hoehe,
        )


def _maske(bild: Image.Image) -> Image.Image:
    return bild.convert("L").point(lambda v: 255 if v < DUNKEL else 0)


def _profil(maske: Image.Image, box: tuple[int, int, int, int], zeilen: bool) -> list[float]:
    """Dunkelanteil je Spalte (oder je Zeile) im Ausschnitt.

    BOX mittelt beim Verkleinern genau: ein Bild der Hoehe 1 hat je Spalte
    den Mittelwert der Spalte.
    """
    teil = maske.crop(box)
    w, h = teil.size
    klein = teil.resize((1, h) if zeilen else (w, 1), Image.Resampling.BOX)
    return [v / 255 for v in klein.tobytes()]


def _linien(profil: list[float], von: int, bis: int, dicke: int) -> list[float]:
    """Mitten der duennen dunklen Laeufe in profil[von:bis] mit heller Umgebung."""
    out: list[float] = []
    i = von
    while i < bis:
        if profil[i] < LINIE_DICHT:
            i += 1
            continue
        j = i
        while j < bis and profil[j] >= LINIE_DICHT:
            j += 1
        breite = j - i
        davor = profil[max(0, i - UMGEBUNG) : i]
        danach = profil[j : min(len(profil), j + UMGEBUNG)]
        if (
            breite <= dicke
            and davor
            and danach
            and max(davor) <= UMGEBUNG_HELL
            and max(danach) <= UMGEBUNG_HELL
        ):
            out.append((i + j - 1) / 2)
        i = j
    return out


def _dunkelanteil(maske: Image.Image, box: tuple[int, int, int, int]) -> float:
    x0, y0, x1, y1 = box
    if x1 - x0 < 1 or y1 - y0 < 1:
        return 0.0
    p = _profil(maske, box, zeilen=False)
    return sum(p) / len(p)


def _randlinien(bild: Image.Image) -> tuple[Image.Image, dict[str, list[float]]]:
    """Die duennen Linien in den vier Randstreifen.

    Schluessel: Streifen und Ende, etwa "oben_links" (senkrechte Linien im
    oberen Streifen, linkes Achtel) oder "links_unten" (waagrechte Linien im
    linken Streifen, unteres Achtel).
    """
    w, h = bild.size
    m = _maske(bild)
    sx, sy = max(4, round(w * STREIFEN)), max(4, round(h * STREIFEN))
    zx, zy = round(w * SUCHE), round(h * SUCHE)
    dicke_x = max(4, round(w * MAX_DICKE))
    dicke_y = max(4, round(h * MAX_DICKE))
    out: dict[str, list[float]] = {}
    for name, y0, y1 in (("oben", 0, sy), ("unten", h - sy, h)):
        p = _profil(m, (0, y0, w, y1), zeilen=False)
        out[f"{name}_links"] = _linien(p, 0, zx, dicke_x)
        out[f"{name}_rechts"] = _linien(p, w - zx, w, dicke_x)
    for name, x0, x1 in (("links", 0, sx), ("rechts", w - sx, w)):
        p = _profil(m, (x0, 0, x1, h), zeilen=True)
        out[f"{name}_oben"] = _linien(p, 0, zy, dicke_y)
        out[f"{name}_unten"] = _linien(p, h - zy, h, dicke_y)
    return m, out


def schnittmarken(bild: Image.Image) -> Schnitt | None:
    """Das Netzformat aus den Schnittmarken, oder None ohne klare Marken."""
    w, h = bild.size
    if w < 200 or h < 200:
        return None
    m, linien = _randlinien(bild)
    sx, sy = max(4, round(w * STREIFEN)), max(4, round(h * STREIFEN))
    # Die innerste Linie ist die Schnittkante (falls ausserdem eine
    # Anschnittmarke weiter aussen steht).
    innen = {
        k: (max(v) if k.endswith(("_links", "_oben")) else min(v)) if v else None
        for k, v in linien.items()
    }
    if any(v is None for v in innen.values()):
        return None
    l_oben, l_unten = innen["oben_links"], innen["unten_links"]
    r_oben, r_unten = innen["oben_rechts"], innen["unten_rechts"]
    o_links, o_rechts = innen["links_oben"], innen["rechts_oben"]
    u_links, u_rechts = innen["links_unten"], innen["rechts_unten"]
    if (
        abs(l_oben - l_unten) > GLEICH * w
        or abs(r_oben - r_unten) > GLEICH * w
        or abs(o_links - o_rechts) > GLEICH * h
        or abs(u_links - u_rechts) > GLEICH * h
    ):
        return None
    links = (l_oben + l_unten) / 2
    rechts = (r_oben + r_unten) / 2
    oben = (o_links + o_rechts) / 2
    unten = (u_links + u_rechts) / 2
    if abs(links - (w - 1 - rechts)) > SYMMETRIE * w or abs(oben - (h - 1 - unten)) > SYMMETRIE * h:
        return None
    # Die Messstreifen muessen ganz im Rand liegen.
    if sx >= links or sy >= oben:
        return None
    # Aussen in jeder Ecke nichts als Papier: ein Bild, das bis an den Rand
    # laeuft, hat hier Farbe. Die innere Haelfte des Randes ist Anschnitt
    # (3 mm), dort darf ein Bild schon stehen.
    ex, ey = int(links * ECKE), int(oben * ECKE)
    for box in (
        (0, 0, ex, ey),
        (w - ex, 0, w, ey),
        (0, h - ey, ex, h),
        (w - ex, h - ey, w, h),
    ):
        if _dunkelanteil(m, box) > ECKE_DUNKEL:
            return None
    return Schnitt(round(links), round(oben), round(rechts), round(unten), w, h)


def marken_passen(bild: Image.Image, schnitt: Schnitt, toleranz: int = 2) -> int:
    """Wie viele der acht Marken genau auf den Kanten von `schnitt` stehen.

    Fuer Seiten, deren eigene Pruefung scheitert, weil ein Bild bis in den
    Anschnitt der Ecke laeuft oder eine Marke verdeckt: stehen die uebrigen
    Marken genau dort, wo sie auf den anderen Seiten des Hefts stehen, ist
    der Schnitt derselbe.
    """
    if bild.size != (schnitt.breite, schnitt.hoehe):
        return 0
    _m, linien = _randlinien(bild)
    soll = {
        "oben_links": schnitt.links,
        "unten_links": schnitt.links,
        "oben_rechts": schnitt.rechts,
        "unten_rechts": schnitt.rechts,
        "links_oben": schnitt.oben,
        "rechts_oben": schnitt.oben,
        "links_unten": schnitt.unten,
        "rechts_unten": schnitt.unten,
    }
    return sum(
        1 for k, ziel in soll.items() if any(abs(v - ziel) <= toleranz for v in linien[k])
    )


def zuschneiden(bild: Image.Image, schnitt: Schnitt) -> Image.Image:
    """Das Netzformat ausschneiden; danach duerfen keine Marken mehr da sein."""
    neu = bild.crop(schnitt.box)
    if schnittmarken(neu) is not None:
        raise ValueError("Nach dem Zuschnitt sind noch Schnittmarken da")
    return neu


def umrechnen(x: float, y: float, anteile: tuple[float, float, float, float]) -> tuple[float, float]:
    """Einen Punkt der alten Seite (Anteile) in die zugeschnittene umrechnen."""
    x0, y0, x1, y1 = anteile
    return ((x - x0) / (x1 - x0), (y - y0) / (y1 - y0))


def textebene_umrechnen(
    daten: bytes, ausschnitte: dict[int, tuple[float, float, float, float]]
) -> bytes | None:
    """Die Textebene (web/src/admin/textLayer.ts) auf zugeschnittene Seiten umrechnen.

    `ausschnitte`: Quellseite -> Ausschnitt in Anteilen der alten Seite. Stuecke,
    deren Mitte ausserhalb liegt (Druckvermerk "… Innenteil.indd 98 28.10.15"
    im Rand), fallen weg. Umgerechnete Seiten stehen unter "beschnitt" in der
    Datei; ein zweiter Lauf laesst sie aus. Ohne Aenderung: None.
    """
    import json

    doc = json.loads(daten)
    erledigt = doc.setdefault("beschnitt", {})
    geaendert = False
    for seite in doc.get("pages", []):
        quelle = seite.get("sourcePageIndex")
        a = ausschnitte.get(quelle)
        if a is None or str(quelle) in erledigt:
            continue
        neu = []
        for it in seite.get("items", []):
            if not isinstance(it, list) or len(it) < 5:
                continue
            (x0, y0), (x1, y1) = umrechnen(it[1], it[2], a), umrechnen(it[3], it[4], a)
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            if not (0 <= mx <= 1 and 0 <= my <= 1):
                continue
            neu.append([it[0], *(min(1.0, max(0.0, round(v, 5))) for v in (x0, y0, x1, y1)), *it[5:]])
        seite["items"] = neu
        erledigt[str(quelle)] = [round(v, 6) for v in a]
        geaendert = True
    if not geaendert:
        return None
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
