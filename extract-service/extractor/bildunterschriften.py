"""Bildunterschriften aus dem Satz ihrem Bild zuordnen.

Der Satz sagt genau, was eine Bildunterschrift ist (Absatzformat
"Bildunterschrift schwarz", "Bildunterschrift weiß", "Bildunterschrift DMZ
2023", "bildunterschrift schwerter") und wo ihr Rahmen steht. Die Zuordnung
zum Bild folgt deshalb der Satzstruktur, nicht der Naehe einzelner Zeilen:

1. **Gruppe.** Hat der Setzer Unterschrift und Bild gruppiert, gehoeren sie
   zusammen. Die engste Gruppe um den Unterschriftrahmen, in der ueberhaupt
   ein Bild steckt, gibt die Kandidaten vor; ist es genau eines, ist es das.
2. **Im Bild.** Die weisse Unterschrift liegt auf dem Foto. Liegt der
   Rahmen zur Haelfte oder mehr in einem Bildrahmen, ist es dessen
   Unterschrift — gleich ob oben, unten oder in der Mitte.
3. **Am Bild.** Sonst steht der Rahmen unter, ueber oder neben einem Bild,
   mit kleinem Abstand und in dessen Spalte. Unter vor ueber vor neben.

Jede Unterschrift geht an hoechstens ein Bild, jedes Bild bekommt hoechstens
eine Unterschrift; das sicherste Paar wird zuerst vergeben. Die vorherige
Regel (`pdf_extract.attach_captions`: nur dicht *unter* dem Bild und
mindestens halb so breit wie das Bild) verlor jede Unterschrift, die auf dem
Foto oder neben ihm steht — ZUERST! 6/2025 S. 34: die weisse Unterschrift
auf dem Schuelerfoto fehlte, das Bild stand ohne Text.

Gearbeitet wird auf den Rahmen (`SourceBlock.frame_box`), nicht auf den
geschaetzten Zeilenlagen: wo eine Zeile im Rahmen umbricht, weiss die IDML
nicht, der Rahmen selbst steht fest.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .model import SourceBlock, SourceImage

# Senkrechter Abstand zwischen Bildkante und Unterschriftrahmen (Anteil der
# Seitenhoehe). Gemessen ueber 13 Hefte (1.216 Unterschriften): ueber und
# unter dem Bild stehen sie 0 bis 0,01 entfernt, fast immer buendig. Bei 0,025
# stand eine Unterschrift schon neben dem naechsten Bild (DMZ 170 S. 18).
ABSTAND = 0.02
# Waagerechter Abstand fuer eine Unterschrift in der Nachbarspalte (ZUERST!
# 3/2026 S. 17: 0,035 zwischen Unterschrift und Bruecken-Foto).
ABSTAND_SEITLICH = 0.04
# Ueberstand, der noch als buendig gilt (Rahmenkanten, Anschnitt).
TOLERANZ = 0.015
# Ab diesem Anteil seiner Flaeche liegt der Rahmen "im" Bild. Darunter
# entscheidet erst die Lage am Rand: ein Rahmen, der breiter ist als sein Text,
# ragt oft halb in ein Nachbarbild (ZUERST! 2/2025 S. 23: die Unterschrift
# unter dem Foto ragt in das eingeklinkte Bild des Tweets).
IM_BILD = 0.8
# Schwaecher Beleg, wenn sonst nichts passt: der Rahmen liegt zu einem Drittel
# auf dem Bild (ZUERST! 1/2025 S. 63, Unterschrift ueber der Bildkante).
IM_BILD_SCHWACH = 0.3
# Signets, Logos, Fusszeilenmarken: so kleine Bilder tragen keine Unterschrift.
KLEINSTBILD = 0.004
# So weit darf ein gruppiertes Bild hoechstens weg sein.
GRUPPE_ABSTAND = 0.12

# So lang darf eine Unterschrift werden; die laengsten im Bestand (DMZ-
# Zeitgeschichte 80) haben gut 900 Zeichen. Frueher war bei 400 Schluss.
LAENGE = 1500

SATZENDE = re.compile(r"[.!?:)\]“”\"»«]\s*$")

QUELLE = ("foto:", "fotos:", "bild:", "bilder:", "grafik:", "abb.:", "quelle:")


@dataclass
class Unterschrift:
    page_index: int
    text: str
    box: tuple[float, float, float, float]
    gruppen: tuple[str, ...]


def _box(block: SourceBlock) -> tuple[float, float, float, float]:
    return block.frame_box or (block.x0, block.y0, block.x1, block.y1)


def unterschriften(blocks: list[SourceBlock]) -> list[Unterschrift]:
    """Unterschriften je Rahmen: die Absaetze eines Rahmens sind ein Text.

    Ein Formatbereich mit Zeilenschaltungen kommt als mehrere Bloecke an
    ("Durch die Zwangskollektivierung" / "wurde vielen Kleinbauern ..."); sie
    bilden zusammen eine Unterschrift. Eine Leerzeile trennt dagegen zwei
    Unterschriften im selben Rahmen, die eine fuer das Bild darueber, die
    andere fuer das darunter (ZUERST! 3/2026 S. 57). Der Rahmen wird dann nach
    der Textmenge in Streifen geteilt, damit jede ihr Bild findet.
    """
    teile: dict[tuple, list[list[SourceBlock]]] = {}
    for b in blocks:
        if b.kind != "caption" or b.drop or b.origin != "idml":
            continue
        if not b.text.strip():
            continue
        key = (b.page_index, b.frame_id or b.story_id or id(b))
        liste = teile.setdefault(key, [])
        # Nur nach einem Satzende: steht die Leerzeile mitten im Satz ("Vor
        # allem auf viele" / "Mitteldeutsche wirkt ..."), ist es eine
        # Unterschrift mit Luft darin.
        if not liste or (b.after_blank and SATZENDE.search(liste[-1][-1].text)):
            liste.append([])
        liste[-1].append(b)
    out: list[Unterschrift] = []
    for liste in teile.values():
        box = _box(liste[0][0])
        laengen = [sum(len(b.text) for b in teil) for teil in liste]
        gesamt = max(sum(laengen), 1)
        oben = box[1]
        for teil, laenge in zip(liste, laengen):
            hoehe = (box[3] - box[1]) * laenge / gesamt if len(liste) > 1 else box[3] - box[1]
            out.append(
                Unterschrift(
                    teil[0].page_index,
                    " ".join(b.text.strip() for b in teil),
                    (box[0], oben, box[2], oben + hoehe),
                    teil[0].frame_groups,
                )
            )
            oben += hoehe
    return out


def _innen(a, b) -> float:
    """Anteil der Flaeche von a, der in b liegt."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    return (w * h) / max((a[2] - a[0]) * (a[3] - a[1]), 1e-9)


def _spalte(c, img) -> float:
    """Waagerechte Ueberdeckung, bezogen auf die schmalere der beiden Breiten."""
    w = min(c[2], img[2]) - max(c[0], img[0])
    return max(0.0, w) / max(min(c[2] - c[0], img[2] - img[0]), 1e-9)


def _breite(c, img) -> float:
    """Welcher Anteil der Unterschriftbreite ueber oder unter dem Bild liegt."""
    w = min(c[2], img[2]) - max(c[0], img[0])
    return max(0.0, w) / max(c[2] - c[0], 1e-9)


def _zeile(c, img) -> float:
    """Senkrechte Ueberdeckung, bezogen auf die Hoehe der Unterschrift."""
    h = min(c[3], img[3]) - max(c[1], img[1])
    return max(0.0, h) / max(c[3] - c[1], 1e-9)


def lage(c, img) -> tuple[str, float] | None:
    """Wie der Unterschriftrahmen zum Bildrahmen steht, mit Guete 0..1."""
    innen = _innen(c, img)
    if innen >= IM_BILD:
        return "im", innen
    # Ein Rahmen, der die Bildkante ueberlappt, zaehlt noch als darunter bzw.
    # darueber, solange hoechstens seine halbe Hoehe im Bild steckt.
    halb = max(TOLERANZ, (c[3] - c[1]) * 0.5)
    spalte = _spalte(c, img)
    if spalte >= 0.5:
        # Guete: buendig an der Kante und ueber die ganze Breite der
        # Unterschrift. Das trennt drei gestaffelte Blaetter, deren Kanten
        # alle in Reichweite liegen (DMZ-Zeitgeschichte 80 S. 32).
        breite = _breite(c, img)
        unter = c[1] - img[3]
        if -halb <= unter <= ABSTAND and c[3] > img[3]:
            return "unter", 0.6 * (1.0 - min(1.0, abs(unter) / ABSTAND)) + 0.4 * breite
        ueber = img[1] - c[3]
        if -halb <= ueber <= ABSTAND and c[1] < img[1]:
            return "ueber", 0.6 * (1.0 - min(1.0, abs(ueber) / ABSTAND)) + 0.4 * breite
    if _zeile(c, img) >= 0.5:
        rechts = c[0] - img[2]
        links = img[0] - c[2]
        # Der Rahmen darf ein Stueck ins Bild ragen, solange der groesste Teil
        # daneben steht (DMZ-Zeitgeschichte 80 S. 39: Unterschrift rechts
        # neben dem Foto, Rahmen 5 Prozent der Seitenbreite im Bild).
        ragt = max(TOLERANZ, (c[2] - c[0]) * 0.25)
        seitlich = rechts if rechts >= -ragt else links
        if -ragt <= seitlich <= ABSTAND_SEITLICH:
            # Buendig zur Unterkante des Bildes ist die uebliche Form.
            unten = 1.0 - min(1.0, abs(c[3] - img[3]) / 0.05)
            return "neben", 0.5 * (1.0 - max(0.0, seitlich) / ABSTAND_SEITLICH) + 0.5 * unten
    if innen >= IM_BILD_SCHWACH:
        return "halb", innen
    return None


GEWICHT = {"im": 3.0, "unter": 2.0, "ueber": 1.6, "neben": 1.2, "halb": 0.8}


def _abstand(c, img) -> float:
    dx = max(0.0, max(c[0], img[0]) - min(c[2], img[2]))
    dy = max(0.0, max(c[1], img[1]) - min(c[3], img[3]))
    return max(dx, dy)


# "Links: Fenster mit Darstellung ..." — die Unterschrift sagt selbst, wo ihr
# Bild steht (ZUERST! 2/2025 S. 61: zwei Unterschriften nebeneinander unter
# dem rechten Foto, die linke gehoert zum Bild links daneben).
RICHTUNG = re.compile(r"^\s*(links|rechts|oben|unten)\s*:", re.I)


def _richtung(u: Unterschrift, img) -> float:
    """Zuschlag, wenn das Bild dort steht, wohin die Unterschrift zeigt."""
    m = RICHTUNG.match(u.text)
    if not m:
        return 0.0
    cx, cy = (u.box[0] + u.box[2]) / 2, (u.box[1] + u.box[3]) / 2
    ix, iy = (img[0] + img[2]) / 2, (img[1] + img[3]) / 2
    passt = {
        "links": ix < cx,
        "rechts": ix > cx,
        "oben": iy < cy,
        "unten": iy > cy,
    }[m.group(1).lower()]
    return 1.5 if passt else -1.5


def _box_auf(img: SourceImage, seite: int) -> tuple[float, float, float, float] | None:
    """Wo das Bild auf dieser Seite steht — auch als Auslaeufer einer Doppelseite."""
    if img.page_index == seite:
        return (img.x0, img.y0, img.x1, img.y1)
    for teil in img.spread_parts:
        if teil[0] == seite:
            return teil[1:]
    return None


def _liegt_in_anderem(box, andere: list) -> bool:
    """Steckt das Bild als deutlich kleineres in einem der anderen?

    Gestaffelte Blaetter gleicher Groesse (drei Seiten eines Dokuments
    uebereinander) sind kein Bild im Bild.
    """
    flaeche = (box[2] - box[0]) * (box[3] - box[1])
    return any(
        o != box
        and flaeche <= 0.5 * (o[2] - o[0]) * (o[3] - o[1])
        and _innen(box, o) >= KASTEN_BILD_ANTEIL
        for o in andere
    )


def _kandidaten_der_gruppe(u: Unterschrift, bilder: list) -> list | None:
    """Die Bilder der engsten Gruppe um die Unterschrift, die ueberhaupt eines hat."""
    for tiefe in range(len(u.gruppen), 0, -1):
        gruppe = u.gruppen[tiefe - 1]
        drin = [(img, box) for img, box in bilder if gruppe in img.groups]
        if drin:
            return drin
    return None


def zuordnen(
    images: list[SourceImage], blocks: list[SourceBlock]
) -> list[tuple[Unterschrift, SourceImage | None, str]]:
    """Jede Unterschrift ihrem Bild zuordnen; setzt `SourceImage.caption`.

    Liefert je Unterschrift das Bild und den Grund ("gruppe", "im", "unter",
    "ueber", "neben", "halb") oder None, wenn kein Bild in Frage kommt — fuer
    Auswertungen und Tests.
    """
    alle = unterschriften(blocks)
    je_seite: dict[int, list[tuple[SourceImage, tuple]]] = {}
    for img in images:
        if (img.x1 - img.x0) * (img.y1 - img.y0) < KLEINSTBILD:
            continue
        for seite in {img.page_index, *(t[0] for t in img.spread_parts)}:
            box = _box_auf(img, seite)
            if box is not None:
                je_seite.setdefault(seite, []).append((img, box))

    paare: list[tuple[float, int, int, SourceImage, str]] = []
    for ui, u in enumerate(alle):
        seite = je_seite.get(u.page_index, [])
        gruppe = _kandidaten_der_gruppe(u, seite)
        kandidaten = gruppe if gruppe is not None else seite
        boxen = [box for _img, box in kandidaten]
        for bi, (img, box) in enumerate(kandidaten):
            gefunden = lage(u.box, box)
            if gefunden is not None:
                art, guete = gefunden
                wert = GEWICHT[art] + guete
            elif gruppe is not None and _abstand(u.box, box) <= GRUPPE_ABSTAND:
                art, wert = "gruppe", 1.0
            else:
                continue
            if gruppe is not None:
                # Die Gruppe ist der staerkste Beleg: sie schlaegt jede Lage
                # ausserhalb der Gruppe.
                wert += 4.0
                if len(gruppe) == 1:
                    art = "gruppe"
            wert += _richtung(u, box)
            # Ein Bild im Bild (Ausschnitt, Detailaufnahme, eingeklinktes
            # Foto) ist genauer als das grosse darunter: liegt die Unterschrift
            # im grossen Bild und zugleich an dem kleinen, gehoert sie zum
            # kleinen (DMZ 170 S. 17: "Trotz der Modellbezeichnung ..." unter
            # der Detailaufnahme des Stempels, beide auf dem Foto der Waffe).
            if _liegt_in_anderem(box, boxen):
                wert += 2.0
            # Bei zwei Bildern uebereinander das kleinere, engere.
            wert -= 0.01 * (box[2] - box[0]) * (box[3] - box[1])
            paare.append((wert, ui, bi, img, art))

    paare.sort(key=lambda p: -p[0])
    vergeben: dict[int, tuple[SourceImage, str]] = {}
    belegt: set[int] = set()
    for _wert, ui, _bi, img, art in paare:
        if ui in vergeben or id(img) in belegt:
            continue
        vergeben[ui] = (img, art)
        belegt.add(id(img))
    # Zweiter Durchgang: eine Unterschrift, deren Bild schon eine hat, haengt
    # sich dazu, wenn sie wirklich an ihm steht. Ein Bild kann zwei tragen,
    # eine auf dem Foto und eine darueber (ZUERST! 3/2025 S. 14).
    for _wert, ui, _bi, img, art in paare:
        if ui in vergeben or art == "gruppe":
            continue
        vergeben[ui] = (img, art)

    ergebnis: list[tuple[Unterschrift, SourceImage | None, str]] = []
    texte: dict[int, list[tuple[float, str]]] = {}
    bilder: dict[int, SourceImage] = {}
    for ui, u in enumerate(alle):
        if ui not in vergeben:
            ergebnis.append((u, None, "keins"))
            continue
        img, art = vergeben[ui]
        ergebnis.append((u, img, art))
        if u.text.lower().startswith(QUELLE):
            continue
        texte.setdefault(id(img), []).append((u.box[1], u.text))
        bilder[id(img)] = img
    for schluessel, liste in texte.items():
        img = bilder[schluessel]
        if img.caption is None:
            img.caption = " ".join(t for _y, t in sorted(liste))[:LAENGE]
    return ergebnis


# Ein Bildrahmen, der zu diesem Anteil im Rahmen einer "Unterschrift" steckt,
# macht aus ihr einen Kasten: Text, der um ein Bild herumlaeuft, beschreibt
# nicht das Bild daneben (ZUERST! 3/2025 S. 11-15, "Szenario 2: Zivile
# Unruhen" im Format "Bildunterschrift schwarz", mit Foto im Kasten).
KASTEN_BILD_ANTEIL = 0.8


def kaesten_im_unterschriftformat(bildrahmen: list, blocks: list[SourceBlock]) -> set[str]:
    """Stories im Unterschriftformat, deren Rahmen selbst ein Bild umschliesst.

    Arbeitet auf den Rohdaten des Satzes (`extract_idml_frames`,
    `extract_idml_blocks`): Seite = `page_number` bzw. `page_index` dort.
    """
    out: set[str] = set()
    for b in blocks:
        if b.kind != "caption" or not b.story_id or b.frame_box is None:
            continue
        for f in bildrahmen:
            if f.page_number != b.page_index:
                continue
            if (f.x1 - f.x0) * (f.y1 - f.y0) < KLEINSTBILD:
                continue
            if _innen((f.x0, f.y0, f.x1, f.y1), b.frame_box) >= KASTEN_BILD_ANTEIL:
                out.add(b.story_id)
                break
    return out


def als_kasten(blocks: list[SourceBlock], stories: set[str]) -> int:
    """Bloecke dieser Stories zu Kaesten machen; liefert die Anzahl."""
    n = 0
    for b in blocks:
        if b.story_id in stories and b.kind == "caption":
            b.kind = "box"
            n += 1
    return n
