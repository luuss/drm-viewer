"""Bildnachweise aus dem Satz ihrem Bild zuordnen.

Der Nachweis ("Foto: Wikimedia/Bernd Schwabe/CC BY-SA 4.0") steht im Heft
als eigener kleiner Textrahmen am Rand des Fotos, meist um 90 Grad gedreht
rechts oder links neben der Bildkante, seltener waagerecht darunter oder auf
dem Foto. Er ist keine Bildunterschrift (`bildunterschriften.NACHWEIS`
filtert ihn dort aus), gehoert aber zum Bild: der Leser zeigt ihn klein
unter der Unterschrift (`SourceImage.credit`, Convex `articleAssets.credit`).

Beleg aus genau diesem Heft:

* **Absatzformat** "Bildquelle", "Bildquelle DMZ 2023", "bildquelle
  schwerter", "Bildnachweis", "Fotonachweis" (alle 13 Hefte mit Satz), oder
* ein Rahmen, dessen ganzer Text ein Nachweis ist ("Foto: ...", "Fotos: ...",
  "Bild: ...", "Quelle: ...", "(c)"/"©") — auch im falschen Format gesetzt
  (Greim: "Foto: Harald Jaudas" im Format "zwischen Titel").

Zuordnung ueber die Geometrie, nicht ueber die Reihenfolge im Satz: der
Rahmen (bei gedrehten Rahmen die achsparallele Huelle, `_path_bounds` rechnet
die Drehung mit) liegt an einer Bildkante an — daneben, darunter, darueber
oder knapp innen auf dem Foto — und laeuft dort entlang der Kante. Eine
Gruppe aus Bild und Nachweis schlaegt die Lage. Je Nachweis ein Bild; ein
Bild mit zwei Nachweisen bekommt beide.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .model import SourceBlock, SourceImage
from .textutil import zeilen_verbinden

# Absatzformate fuer den Nachweis (wie in `idml_extract.STYLE_RULES`).
FORMAT = re.compile(r"bild\s*quelle|bild\s*nachweis|foto\s*nachweis|fotoquelle|bildrechte|credit", re.I)
# Text, der fuer sich ein Nachweis ist.
TEXT = re.compile(
    r"^\s*(?:(?:alle\s+)?(?:fotos?|bilder?|bild|abb\.?|abbildungen?|grafiken?|karten?|"
    r"illustrationen?|zeichnungen?|quellen?|repro|montage)\b[^:\n]{0,40}:|\(c\)\s|©)",
    re.I,
)
# Ein Nachweis fuer alle Bilder der Seite ("Alle Fotos auf dieser Seite: ...")
# gehoert keinem einzelnen Bild.
SEITENNACHWEIS = re.compile(
    r"\b(?:alle|s[aä]mtliche)\s+(?:fotos|bilder|abbildungen)\b[^:]{0,30}(?:seite|seiten)\b", re.I
)
QUELLENFORM = re.compile(r"^[^:]{1,40}:|/|©|\bCC\b", re.I)
ANZEIGE = re.compile(r"^\s*anzeigen?\s*$", re.I)
PLATZHALTER = re.compile(r"\bx{3,}\b", re.I)
# Laenger ist kein Nachweis mehr, sondern Text.
LAENGE = 240

# Wie weit der Rahmen von der Bildkante abstehen darf (Anteil der Seite).
# Gemessen ueber 13 Hefte: fast alle 0 bis 0,005 neben der Kante.
ABSTAND = 0.02
# Wie weit der Rahmen innen auf dem Foto von der Kante entfernt sein darf.
INNEN = 0.04
# Bei einem Foto, das in den Anschnitt laeuft, steht der Nachweis im
# Seitenrand auf dem Foto (DMZ 170 S. 4: 0,04 vom Seitenrand; Greim S. 19:
# 0,048), also weiter von der Bildkante weg.
INNEN_RANDBILD = 0.065
# So nah am Seitenrand gilt eine Bildkante als angeschnitten.
RAND = 0.005
# Welcher Anteil der Rahmenlaenge entlang der Bildkante liegen muss.
ENTLANG = 0.4
# Liegt der Rahmen zu diesem Anteil auf einem Foto, gehoert er ihm, auch ohne
# Kante (nur wenn kein Bild an einer Kante passt).
AUF_DEM_FOTO = 0.8
# Signets und Logos tragen keinen Nachweis.
KLEINSTBILD = 0.004
# So weit darf ein gruppiertes Bild hoechstens weg sein.
GRUPPE_ABSTAND = 0.05
# Gleich nah: dann das kleinere Bild. Der Nachweis im Spaltenzwischenraum
# steht 0,0019 neben dem einen und 0,0076 neben dem anderen Foto; das naehere
# ist seins (ZUERST! 2/2025 S. 59: "Foto: U.S. Army" am Foto der Ritchie
# Boys, 0,0019, nicht am Spiegel-Titel daneben, 0,0021).
GLEICH = 0.0001
# Der Satz stellt den gedrehten Nachweis an die rechte Bildkante (1.281 von
# 1.419 eindeutigen Faellen in 13 Heften). Steht er im Spaltenzwischenraum
# zwischen zwei Fotos, gehoert er zum linken, auch wenn er dem rechten ein
# Stueck naeher ist (ZUERST! 7/2025 S. 7: "Olaf Kosinsky" 0,0016 neben dem
# Wadephul-Foto von Kosinsky, 0,0008 neben dem Pistorius-Foto aus dem
# Pentagon; S. 18: "Pixabay/Dieter Löffler" am Pixabay-Bild links, nicht am
# Kosinsky-Foto rechts).
VORZUG = 0.005


@dataclass
class Nachweis:
    page_index: int
    text: str
    box: tuple[float, float, float, float]
    gruppen: tuple[str, ...]


def _box(block: SourceBlock) -> tuple[float, float, float, float]:
    return block.frame_box or (block.x0, block.y0, block.x1, block.y1)


def ist_nachweisformat(style_name: str | None) -> bool:
    return bool(style_name and FORMAT.search(style_name))


def nachweise(blocks: list[SourceBlock]) -> list[Nachweis]:
    """Nachweise je Rahmen: ein Rahmen im Nachweisformat oder ganz aus Nachweistext."""
    rahmen: dict[tuple, list[SourceBlock]] = {}
    for b in blocks:
        if b.origin != "idml" or not b.text.strip():
            continue
        key = (b.page_index, b.frame_id or b.story_id or id(b))
        rahmen.setdefault(key, []).append(b)
    out: list[Nachweis] = []
    for liste in rahmen.values():
        eigene = [b for b in liste if ist_nachweisformat(b.style_name)]
        if not eigene:
            # Ohne Format zaehlt nur ein Rahmen, der ganz Nachweis ist.
            ganz = zeilen_verbinden(b.text for b in liste)
            if len(ganz) > LAENGE or not TEXT.match(ganz):
                continue
            eigene = liste
        text = zeilen_verbinden(b.text for b in eigene).strip()
        if not text or len(text) > LAENGE or SEITENNACHWEIS.search(text):
            continue
        # Die Kennzeichnung "Anzeige" steht im selben Format, ist aber keine
        # Quelle; "Foto: xxx" ist ein Platzhalter des Setzers.
        if ANZEIGE.match(text) or PLATZHALTER.search(text):
            continue
        # Auch im Nachweisformat muss der Text wie eine Quelle aussehen
        # ("Graphik: dpa", "Wikimedia/French Maclean/CC BY-SA 4.0"). ZUERST!
        # 1/2025 S. 63 setzt eine Kalenderanzeige im Format "Bildquelle".
        if not QUELLENFORM.search(text):
            continue
        out.append(Nachweis(eigene[0].page_index, text, _box(eigene[0]), eigene[0].frame_groups))
    return out


def _innen(a, b) -> float:
    """Anteil der Flaeche von a, der in b liegt."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    return (w * h) / max((a[2] - a[0]) * (a[3] - a[1]), 1e-9)


def _entlang(a0, a1, b0, b1) -> float:
    """Anteil der Strecke a, der neben der Strecke b liegt."""
    return max(0.0, min(a1, b1) - max(a0, b0)) / max(a1 - a0, 1e-9)


def lage(c, img) -> tuple[str, float] | None:
    """Wie der Nachweis an der Bildkante liegt: (Seite, Abstand) oder None.

    Abstand: Luecke zur Kante (0, wenn der Rahmen ueber die Kante reicht),
    oder wie weit er innen auf dem Foto von der Kante steht. Gemessen wird an
    der naechsten Kante, und nur, wenn der Rahmen entlang dieser Kante laeuft.
    """
    kandidaten = []
    # (Seite, Luecke nach aussen, Abstand der fernen Rahmenkante zur Bildkante,
    # liegt die Bildkante am Seitenrand). Ein hoher, schmaler Rahmen ist
    # gedreht und steht an einer senkrechten Kante, ein flacher an einer
    # waagerechten (ZUERST! 4/2025 S. 42: der gedrehte Nachweis des Porträts
    # reicht unten ueber das Logo darunter und gehoert doch zum Porträt).
    if c[3] - c[1] > c[2] - c[0]:
        if _entlang(c[1], c[3], img[1], img[3]) >= ENTLANG:
            kandidaten.append(("rechts", c[0] - img[2], img[2] - c[2], img[2] >= 1 - RAND))
            kandidaten.append(("links", img[0] - c[2], c[0] - img[0], img[0] <= RAND))
    elif _entlang(c[0], c[2], img[0], img[2]) >= ENTLANG:
        kandidaten.append(("unter", c[1] - img[3], img[3] - c[3], img[3] >= 1 - RAND))
        kandidaten.append(("ueber", img[1] - c[3], c[1] - img[1], img[1] <= RAND))
    beste = None
    for seite, luecke, innen, am_rand in kandidaten:
        if luecke >= 0:
            # ganz neben dem Bild
            wert = luecke if luecke <= ABSTAND else None
        elif innen <= 0:
            # ueber der Kante: so gut wie buendig
            wert = 0.0
        else:
            # ganz auf dem Foto, so weit von der Kante
            grenze = INNEN_RANDBILD if am_rand else INNEN
            wert = innen + 0.001 if innen <= grenze else None
        if wert is not None and (beste is None or wert < beste[1]):
            beste = (seite, wert)
    return beste


def _box_auf(img: SourceImage, seite: int):
    if img.page_index == seite:
        return (img.x0, img.y0, img.x1, img.y1)
    for teil in img.spread_parts:
        if teil[0] == seite:
            return teil[1:]
    return None


def _abstand(c, img) -> float:
    dx = max(0.0, max(c[0], img[0]) - min(c[2], img[2]))
    dy = max(0.0, max(c[1], img[1]) - min(c[3], img[3]))
    return max(dx, dy)


def zuordnen(
    images: list[SourceImage], blocks: list[SourceBlock]
) -> list[tuple[Nachweis, SourceImage | None, str]]:
    """Jeden Nachweis seinem Bild zuordnen; setzt `SourceImage.credit`.

    Liefert je Nachweis das Bild und die Lage ("rechts", "links", "unter",
    "ueber", "gruppe", "auf") oder (None, "keins") — fuer Auswertung und Tests.
    """
    alle = nachweise(blocks)
    je_seite: dict[int, list[tuple[SourceImage, tuple]]] = {}
    for img in images:
        if (img.x1 - img.x0) * (img.y1 - img.y0) < KLEINSTBILD:
            continue
        for seite in {img.page_index, *(t[0] for t in img.spread_parts)}:
            box = _box_auf(img, seite)
            if box is not None:
                je_seite.setdefault(seite, []).append((img, box))

    ergebnis: list[tuple[Nachweis, SourceImage | None, str]] = []
    texte: dict[int, list[tuple[float, str]]] = {}
    bilder: dict[int, SourceImage] = {}
    for n in alle:
        seite = je_seite.get(n.page_index, [])
        kandidaten = seite
        in_gruppe = False
        for tiefe in range(len(n.gruppen), 0, -1):
            drin = [(i, b) for i, b in seite if n.gruppen[tiefe - 1] in i.groups]
            if drin:
                kandidaten, in_gruppe = drin, True
                break
        beste = None
        for img, box in kandidaten:
            gefunden = lage(n.box, box)
            if gefunden is None:
                if in_gruppe and len(kandidaten) == 1 and _abstand(n.box, box) <= GRUPPE_ABSTAND:
                    gefunden = ("gruppe", _abstand(n.box, box))
                elif _innen(n.box, box) >= AUF_DEM_FOTO:
                    # Mitten auf dem Foto, an keiner Kante (ZUERST! 8-9/2025
                    # S. 84: waagerecht auf der Flagge). Schwaechster Beleg.
                    gefunden = ("auf", 1.0)
                else:
                    continue
            art, wert = gefunden
            # Der Nachweis steht rechts neben (oder unter) seinem Foto; links
            # davon nur, wenn rechts keines nah genug ist.
            if art in ("links", "ueber"):
                wert += VORZUG
            # Bei gleichem Abstand das kleinere Bild: ein eingeklinktes Foto
            # auf dem grossen traegt seinen eigenen Nachweis.
            flaeche = (box[2] - box[0]) * (box[3] - box[1])
            if (
                beste is None
                or wert < beste[0] - GLEICH
                or (abs(wert - beste[0]) <= GLEICH and flaeche < beste[1])
            ):
                beste = (wert, flaeche, img, art)
        if beste is None:
            ergebnis.append((n, None, "keins"))
            continue
        _w, _f, img, art = beste
        ergebnis.append((n, img, art))
        texte.setdefault(id(img), []).append((n.box[1], n.text))
        bilder[id(img)] = img
    for schluessel, liste in texte.items():
        img = bilder[schluessel]
        gesehen: list[str] = []
        for _y, t in sorted(liste):
            if t not in gesehen:
                gesehen.append(t)
        img.credit = " · ".join(gesehen)[:LAENGE * 2]
    return ergebnis
