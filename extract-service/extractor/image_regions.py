"""Bildbereiche einer Druckseite verlaesslich bestimmen.

Das Problem: `pdfplumber.page.images` nennt nur die Platzierungsrechtecke der
Bild-XObjects. Was davon sichtbar ist, steht dort nicht. Im Magazinsatz ist der
Unterschied gross:

* Ein Bild liegt fast immer unter einem Beschnittpfad. InDesign legt die Datei
  in voller Groesse ab und zeigt nur den Ausschnitt im Rahmen. Ohne den Pfad
  schneidet man Nachbarspalten mit heraus.
* Ganzseitige Hintergrundbilder tragen den kompletten Seitentext auf sich. Als
  Artikelbild sind sie wertlos.
* Ein Bild wird oft mehrfach uebereinandergelegt (Bild, Weichzeichnermaske,
  Farbfeld). Jede Lage einzeln zu schneiden ergibt Dubletten.
* Logos, Linien und Schmuckstreifen sind technisch ebenfalls Bilder.

Die Geometrie kommt deshalb aus PDFium (`pypdfium2`, schon fuer das Rendern
vorhanden): dort ist der Beschnittpfad je Objekt abfragbar. Danach raeumen ein
paar Regeln auf, die alle an denselben Massstaeben haengen — Netzformat der
Seite (Trimbox) und die Wortrechtecke aus der Textebene.

Alle Koordinaten sind auf die **volle gerenderte Seite** normiert (0..1, y von
oben), denn der Ausschnitt wird spaeter aus genau diesem Seitenbild geschnitten.
"""

from __future__ import annotations

import ctypes
import io
from collections import Counter
from dataclasses import dataclass

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

from .page_geometry import rect_on_visible_page, visible_page_box

Rect = tuple[float, float, float, float]

# --- Schwellen -------------------------------------------------------------
# Die Werte sind am Musterheft (ZUERST! 3/2026, 84 Seiten) gemessen; siehe
# tools/bildauswertung.py.

MIN_AREA = 0.010          # Flaechenanteil der Seite, ab dem ein Bild zaehlt
MIN_SIDE = 0.055          # kuerzeste Kante, ab der ein Bild zaehlt
MAX_ASPECT = 5.5          # laenger als das ist ein Streifen, kein Bild
MIN_SOURCE_PX = 90        # Quellaufloesung unterhalb davon: Symbol, kein Foto

BACKGROUND_AREA = 0.58    # Anteil der Netzflaeche, ab dem Hintergrund droht
BACKGROUND_TEXT = 0.02    # Textdichte, ab der ein grosses Bild Hintergrund ist
TEXT_DENSITY_DROP = 0.07  # Textdichte, ab der das Rechteck Satzspiegel ueberdeckt
TEXT_SPREAD_DROP = 0.45   # Anteil der Rasterfelder mit Text: verteilter Satz
TEXT_MIN_AREA = 0.03      # darunter faelscht schon eine Zeile das Bild

MERGE_OVERLAP = 0.45      # Schnitt/kleinere Flaeche, ab der zwei Lagen eins sind
MERGE_GROWTH = 1.8        # die Vereinigung darf nicht beliebig Leerraum fressen

FURNITURE_PAGES = 0.25    # gleiches Rechteck auf so vielen Seiten: Seitenschmuck
FURNITURE_MIN = 4


@dataclass
class RawImage:
    """Ein platziertes Bildobjekt, bereits mit Beschnittpfad verrechnet."""

    rect: Rect
    stencil: bool = False     # 1-Bit-Maske: Logo oder Strichzeichnung
    source_px: int = 0        # kuerzere Kante der Quelldatei in Pixeln


# --- Geometrie -------------------------------------------------------------


def area(r: Rect) -> float:
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def intersect(a: Rect, b: Rect) -> Rect:
    return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))


def union(a: Rect, b: Rect) -> Rect:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def overlap_area(a: Rect, b: Rect) -> float:
    return area(intersect(a, b))


def _clip_rect(obj) -> Rect | None:
    """Umschliessendes Rechteck des Beschnittpfads eines Seitenobjekts.

    Mehrere Pfade wirken nacheinander, also wird geschnitten, nicht vereinigt.
    Ein freier Pfad (Ausschneider) wird auf sein Rechteck vergroebert; das ist
    immer noch deutlich naeher am Sichtbaren als die Platzierung.
    """
    clip = pdfium_raw.FPDFPageObj_GetClipPath(obj.raw)
    if not clip:
        return None
    count = pdfium_raw.FPDFClipPath_CountPaths(clip)
    if count <= 0:
        return None
    box: Rect | None = None
    for path_index in range(count):
        segments = pdfium_raw.FPDFClipPath_CountPathSegments(clip, path_index)
        xs: list[float] = []
        ys: list[float] = []
        for seg_index in range(segments):
            segment = pdfium_raw.FPDFClipPath_GetPathSegment(clip, path_index, seg_index)
            x = ctypes.c_float()
            y = ctypes.c_float()
            if pdfium_raw.FPDFPathSegment_GetPoint(segment, ctypes.byref(x), ctypes.byref(y)):
                xs.append(x.value)
                ys.append(y.value)
        if not xs:
            continue
        here = (min(xs), min(ys), max(xs), max(ys))
        box = here if box is None else intersect(box, here)
    return box


def _metadata(obj, page) -> tuple[bool, int]:
    """(ist Stempelmaske, kuerzere Kante der Quelldatei)."""
    meta = pdfium_raw.FPDF_IMAGEOBJ_METADATA()
    if not pdfium_raw.FPDFImageObj_GetImageMetadata(obj.raw, page.raw, ctypes.byref(meta)):
        return False, 0
    return meta.bits_per_pixel <= 1, min(int(meta.width), int(meta.height))


def read_trim_boxes(
    pdf_bytes: bytes,
    page_map: list[tuple[int, int]],
    halves: dict[int, str] | None = None,
) -> dict[int, Rect]:
    """Netzformat je kanonischer Seite im Koordinatensystem des Renderings.

    Der IDML-Weg braucht nur das, nicht die Bildobjekte: der Satz kennt die
    Seite ohne Anschnitt. Weil das Rendering nun ebenfalls genau die TrimBox
    zeigt, ist deren normiertes Rechteck immer die volle sichtbare Seite.
    """
    trims: dict[int, Rect] = {}
    doc = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
    try:
        for source_index, canonical_index in sorted(page_map):
            if source_index >= len(doc):
                continue
            page = doc[source_index]
            left, bottom, right, top = visible_page_box(
                page, (halves or {}).get(canonical_index)
            )
            if right <= left or top <= bottom:
                continue
            trims[canonical_index] = (0.0, 0.0, 1.0, 1.0)
    finally:
        doc.close()
    return trims


def read_raw_images(
    pdf_bytes: bytes,
    page_map: list[tuple[int, int]],
    halves: dict[int, str] | None = None,
) -> tuple[dict[int, list[RawImage]], dict[int, Rect]]:
    """Bildobjekte und Netzformat je kanonischer Seite lesen.

    Rueckgabe: (Bilder je Seite, Trimbox je Seite) — beides normiert auf die
    gerenderte TrimBox, y von oben. Bei einer Doppelseite nennt `halves` die
    Haelfte, die als Seite zaehlt; Objekte der anderen Haelfte fallen beim
    Schnitt mit dem Netzformat weg.
    """
    images: dict[int, list[RawImage]] = {}
    trims: dict[int, Rect] = {}
    doc = pdfium.PdfDocument(io.BytesIO(pdf_bytes))
    try:
        # Eine Quellseite kann zwei Leserseiten liefern (Umschlag-Doppelseite).
        for source_index, canonical_index in sorted(page_map):
            if source_index >= len(doc):
                continue
            page = doc[source_index]
            visible = visible_page_box(page, (halves or {}).get(canonical_index))
            if visible[2] <= visible[0] or visible[3] <= visible[1]:
                continue

            def norm(box) -> Rect:
                return rect_on_visible_page(box, visible)

            trims[canonical_index] = (0.0, 0.0, 1.0, 1.0)

            found: list[RawImage] = []
            for obj in page.get_objects(max_depth=6):
                if obj.type != pdfium_raw.FPDF_PAGEOBJ_IMAGE:
                    continue
                bounds = obj.get_bounds()
                clip = _clip_rect(obj)
                if clip is not None:
                    bounds = intersect(bounds, clip)
                if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
                    continue
                stencil, source_px = _metadata(obj, page)
                found.append(RawImage(norm(bounds), stencil=stencil, source_px=source_px))
            images[canonical_index] = found
    finally:
        doc.close()
    return images, trims


# --- Regeln ----------------------------------------------------------------


def text_density(rect: Rect, words: list[Rect]) -> float:
    """Anteil der Rechteckflaeche, den Wortrechtecke bedecken.

    Fliesstext liegt bei 0,15 bis 0,45. Ein Foto mit Schlagzeile darauf bleibt
    unter 0,05. Damit trennt dieser eine Wert Masken und Hintergruende von
    echten Bildern, ohne die Schriftgroesse zu kennen.
    """
    flaeche = area(rect)
    if flaeche <= 0:
        return 0.0
    return sum(overlap_area(rect, w) for w in words) / flaeche


def text_spread(rect: Rect, words: list[Rect], raster: int = 4) -> float:
    """Anteil des Rechtecks, ueber den sich Text verteilt.

    Die Textdichte allein reicht nicht: eine ins Bild gesetzte Bildunterschrift
    kann dieselbe Dichte erreichen wie eine Textspalte. Der Unterschied ist die
    Verteilung. Die Unterschrift sitzt in einer Ecke, der Satzspiegel fuellt die
    ganze Flaeche. Gezaehlt werden deshalb die Felder eines groben Rasters, in
    denen ueberhaupt Text liegt.
    """
    breite = rect[2] - rect[0]
    hoehe = rect[3] - rect[1]
    if breite <= 0 or hoehe <= 0:
        return 0.0
    belegt: set[tuple[int, int]] = set()
    for w in words:
        s = intersect(rect, w)
        if s[2] <= s[0] or s[3] <= s[1]:
            continue
        spalte_a = min(raster - 1, int((s[0] - rect[0]) / breite * raster))
        spalte_b = min(raster - 1, int((s[2] - rect[0]) / breite * raster))
        zeile_a = min(raster - 1, int((s[1] - rect[1]) / hoehe * raster))
        zeile_b = min(raster - 1, int((s[3] - rect[1]) / hoehe * raster))
        for zeile in range(zeile_a, zeile_b + 1):
            for spalte in range(spalte_a, spalte_b + 1):
                belegt.add((zeile, spalte))
    return len(belegt) / (raster * raster)


def _too_small(rect: Rect, raw: RawImage) -> bool:
    breite = rect[2] - rect[0]
    hoehe = rect[3] - rect[1]
    if breite <= 0 or hoehe <= 0:
        return True
    if area(rect) < MIN_AREA:
        return True
    if min(breite, hoehe) < MIN_SIDE:
        return True
    if max(breite, hoehe) / min(breite, hoehe) > MAX_ASPECT:
        return True
    if raw.source_px and raw.source_px < MIN_SOURCE_PX:
        return True
    return False


def _merge_stacked(rects: list[Rect], words: list[Rect]) -> list[Rect]:
    """Uebereinanderliegende Lagen zu einem Bildbereich zusammenfassen.

    Zwei Lagen gehoeren zusammen, wenn die kleinere weitgehend in der groesseren
    steckt. Zusammengefasst wird aber nur, wenn die Vereinigung nicht deutlich
    mehr Flaeche belegt als beide zusammen und dabei kein Satz hineinrutscht —
    sonst klebt man zwei Fotos ueber eine Textspalte hinweg aneinander.
    """
    offen = list(rects)
    geaendert = True
    while geaendert:
        geaendert = False
        for i in range(len(offen)):
            for j in range(i + 1, len(offen)):
                a, b = offen[i], offen[j]
                schnitt = overlap_area(a, b)
                if schnitt <= 0:
                    continue
                if schnitt < min(area(a), area(b)) * MERGE_OVERLAP:
                    continue
                zusammen = union(a, b)
                if area(zusammen) > (area(a) + area(b) - schnitt) * MERGE_GROWTH:
                    continue
                if text_density(zusammen, words) > TEXT_DENSITY_DROP:
                    continue
                offen[i] = zusammen
                offen.pop(j)
                geaendert = True
                break
            if geaendert:
                break
    return offen


def select_regions(
    raw_images: list[RawImage],
    words: list[Rect],
    trim: Rect,
    body_words: list[Rect] | None = None,
) -> list[Rect]:
    """Aus den Rohrechtecken einer Seite die brauchbaren Bildbereiche machen.

    `words` sind alle Wortrechtecke der Seite, `body_words` nur die in
    Grundschriftgroesse. Der Unterschied entscheidet ueber Karten und
    Infografiken: deren Beschriftung sieht wie Satz aus, ist aber kleiner
    gesetzt als der Fliesstext. Ohne diese Trennung verwirft man jede Karte.
    """
    netto = max(area(trim), 1e-6)
    satz = words if body_words is None else body_words
    kandidaten: list[Rect] = []

    for raw in raw_images:
        if raw.stencil:
            # 1-Bit-Masken sind Logos, Signets und Strichgrafik.
            continue
        # Alles ausserhalb des Netzformats ist Anschnitt und Druckmarke.
        rect = intersect(raw.rect, trim)
        if _too_small(rect, raw):
            continue

        anteil = area(rect) / netto
        dichte = text_density(rect, words)
        if anteil > BACKGROUND_AREA and dichte > BACKGROUND_TEXT:
            # Ganzseitiges Bild, auf dem der Seitentext steht: Hintergrund.
            continue
        if (
            area(rect) >= TEXT_MIN_AREA
            and text_density(rect, satz) > TEXT_DENSITY_DROP
            and text_spread(rect, satz) > TEXT_SPREAD_DROP
        ):
            # Fliesstext ueber die ganze Flaeche verteilt: das Rechteck deckt
            # den Satzspiegel ab, ist also Maske oder Farbfeld. Eine ins Bild
            # gesetzte Unterschrift bleibt auf wenige Rasterfelder beschraenkt,
            # und Kartenbeschriftung ist kleiner als die Grundschrift.
            continue
        kandidaten.append(rect)

    zusammengefasst = _merge_stacked(kandidaten, satz)

    # Nach dem Zusammenfassen kann ein Bereich gewachsen sein und nun doch
    # Hintergrund oder Streifen sein.
    ergebnis = []
    for rect in zusammengefasst:
        if area(rect) < MIN_AREA or min(rect[2] - rect[0], rect[3] - rect[1]) < MIN_SIDE:
            continue
        if area(rect) / netto > BACKGROUND_AREA and text_density(rect, words) > BACKGROUND_TEXT:
            continue
        ergebnis.append(rect)
    ergebnis.sort(key=lambda r: (round(r[1], 3), r[0]))
    return ergebnis


def drop_repeating(regions: dict[int, list[Rect]], page_count: int) -> dict[int, list[Rect]]:
    """Immer gleiche Rechtecke ueber viele Seiten sind Seitenschmuck.

    Rubrikbalken, Signets und Randstreifen stehen auf jeder Seite an derselben
    Stelle. Der Text bekommt dieselbe Behandlung in `mark_furniture`.
    """
    zaehler: Counter[tuple] = Counter()
    for rects in regions.values():
        # Je Seite nur einmal zaehlen, sonst haelt ein Doppel auf einer Seite
        # schon fuer Schmuck.
        for schluessel in {tuple(round(v, 2) for v in r) for r in rects}:
            zaehler[schluessel] += 1
    grenze = max(FURNITURE_MIN, int(page_count * FURNITURE_PAGES))
    schmuck = {r for r, n in zaehler.items() if n >= grenze}
    if not schmuck:
        return regions
    return {
        seite: [r for r in rects if tuple(round(v, 2) for v in r) not in schmuck]
        for seite, rects in regions.items()
    }
