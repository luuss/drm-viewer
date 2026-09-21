"""Seiten rendern und Titelbilder erzeugen.

Gerendert wird mit PDFium ueber `pypdfium2` (BSD/Apache). PyMuPDF steht unter
AGPL und ist damit fuer den proprietaeren Betrieb heikel; es kommt im
Produktionspfad nicht mehr vor.
"""

from __future__ import annotations

import io

import pypdfium2 as pdfium
from PIL import Image

from extractor.page_geometry import visible_page_box

# Breite der abgelegten Seitenfassung. Daraus schneidet das Kachel-Gateway
# seine Kacheln; das reicht fuer scharfen Zoom auf Magazinseiten.
PAGE_WIDTH_PX = int(__import__("os").environ.get("PAGE_RENDER_WIDTH", "2400"))
PAGE_JPEG_QUALITY = int(__import__("os").environ.get("PAGE_JPEG_QUALITY", "88"))
COVER_WIDTH_PX = 900


def render_page(
    pdf_bytes: bytes,
    page_index: int,
    width_px: int = PAGE_WIDTH_PX,
    half: str | None = None,
):
    """Gibt die sichtbare Druckseite als (jpeg_bytes, breite, hoehe) zurueck.

    Gerendert wird die TrimBox, nicht die volle MediaBox. Letztere enthaelt bei
    Druckdaten Anschnitt, Marken und auf Umschlagboegen mitunter einen Streifen
    der Nachbarseite. Liegt der Umschlag als Doppelseite vor, benennt `half`
    die Haelfte, die als Leserseite gilt.
    """
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        left, bottom, right, top = visible_page_box(page, half)
        point_width = right - left
        scale = max(0.2, width_px / point_width)
        bitmap = page.render(
            scale=scale,
            crop=(
                left,
                bottom,
                max(0.0, page.get_width() - right),
                max(0.0, page.get_height() - top),
            ),
        )
        image = bitmap.to_pil().convert("RGB")
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=PAGE_JPEG_QUALITY, optimize=True)
        return buf.getvalue(), image.width, image.height
    finally:
        doc.close()


def page_count(pdf_bytes: bytes) -> int:
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        return len(doc)
    finally:
        doc.close()


def make_thumbnail(jpeg_bytes: bytes, width_px: int = COVER_WIDTH_PX) -> bytes:
    image = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
    if image.width > width_px:
        height = round(image.height * width_px / image.width)
        image = image.resize((width_px, height), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=85, optimize=True)
    return buf.getvalue()


BLANK_LEVEL = 238        # ab diesem Grauwert gilt eine Randzeile als Papier
BLANK_SPREAD = 14        # zulaessige Schwankung innerhalb der Randzeile
BLANK_MAX_SHARE = 0.30   # hoechstens so viel darf je Seite wegfallen


def _blank_border(image: Image.Image) -> tuple[int, int, int, int]:
    """Gleichmaessig helle Raender messen.

    Der Beschnittpfad aus dem Satz ist oft keine Rechteckform (freigestellte
    Person, Schraege). Sein umschliessendes Rechteck enthaelt dann Papier. Das
    laesst sich am fertigen Seitenbild nachmessen: eine Randzeile, die fast
    weiss und dabei gleichmaessig ist, gehoert nicht zum Bild.

    Abgeschnitten wird hoechstens ein knappes Drittel je Seite, damit ein Foto
    mit hellem Himmel oder weissem Studiogrund nicht zerlegt wird.
    """
    grau = image.convert("L")
    breite, hoehe = grau.size
    pixel = grau.load()

    def zeile_leer(y: int) -> bool:
        werte = [pixel[x, y] for x in range(0, breite, max(1, breite // 64))]
        return min(werte) >= BLANK_LEVEL - BLANK_SPREAD and sum(werte) / len(werte) >= BLANK_LEVEL

    def spalte_leer(x: int) -> bool:
        werte = [pixel[x, y] for y in range(0, hoehe, max(1, hoehe // 64))]
        return min(werte) >= BLANK_LEVEL - BLANK_SPREAD and sum(werte) / len(werte) >= BLANK_LEVEL

    oben, unten = 0, hoehe - 1
    grenze_y = int(hoehe * BLANK_MAX_SHARE)
    while oben < grenze_y and zeile_leer(oben):
        oben += 1
    while unten > hoehe - 1 - grenze_y and zeile_leer(unten):
        unten -= 1

    links, rechts = 0, breite - 1
    grenze_x = int(breite * BLANK_MAX_SHARE)
    while links < grenze_x and spalte_leer(links):
        links += 1
    while rechts > breite - 1 - grenze_x and spalte_leer(rechts):
        rechts -= 1

    if rechts - links < breite * 0.2 or unten - oben < hoehe * 0.2:
        return (0, 0, breite, hoehe)
    return (links, oben, rechts + 1, unten + 1)


def crop_region(
    jpeg_bytes: bytes,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    trim_blank: bool = True,
) -> bytes:
    """Bildausschnitt in normierten Koordinaten — fuer Artikelbilder."""
    image = Image.open(io.BytesIO(jpeg_bytes)).convert("RGB")
    box = (
        max(0, int(x0 * image.width)),
        max(0, int(y0 * image.height)),
        min(image.width, int(x1 * image.width)),
        min(image.height, int(y1 * image.height)),
    )
    if box[2] - box[0] < 8 or box[3] - box[1] < 8:
        raise ValueError("Ausschnitt zu klein")
    cropped = image.crop(box)
    if trim_blank:
        cropped = cropped.crop(_blank_border(cropped))
    if cropped.width > 1600:
        height = round(cropped.height * 1600 / cropped.width)
        cropped = cropped.resize((1600, height), Image.LANCZOS)
    buf = io.BytesIO()
    cropped.save(buf, format="JPEG", quality=82, optimize=True)
    return buf.getvalue()
