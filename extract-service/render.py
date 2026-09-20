"""Seiten rendern und Titelbilder erzeugen.

Gerendert wird mit PDFium ueber `pypdfium2` (BSD/Apache). PyMuPDF steht unter
AGPL und ist damit fuer den proprietaeren Betrieb heikel; es kommt im
Produktionspfad nicht mehr vor.
"""

from __future__ import annotations

import io

import pypdfium2 as pdfium
from PIL import Image

# Breite der abgelegten Seitenfassung. Daraus schneidet das Kachel-Gateway
# seine Kacheln; das reicht fuer scharfen Zoom auf Magazinseiten.
PAGE_WIDTH_PX = int(__import__("os").environ.get("PAGE_RENDER_WIDTH", "2400"))
PAGE_JPEG_QUALITY = int(__import__("os").environ.get("PAGE_JPEG_QUALITY", "88"))
COVER_WIDTH_PX = 900


def render_page(pdf_bytes: bytes, page_index: int, width_px: int = PAGE_WIDTH_PX):
    """Gibt (jpeg_bytes, breite, hoehe) der gerenderten Seite zurueck."""
    doc = pdfium.PdfDocument(pdf_bytes)
    try:
        page = doc[page_index]
        point_width = page.get_width()
        scale = max(0.2, width_px / point_width)
        bitmap = page.render(scale=scale)
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


def crop_region(jpeg_bytes: bytes, x0: float, y0: float, x1: float, y1: float) -> bytes:
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
    if cropped.width > 1600:
        height = round(cropped.height * 1600 / cropped.width)
        cropped = cropped.resize((1600, height), Image.LANCZOS)
    buf = io.BytesIO()
    cropped.save(buf, format="JPEG", quality=82, optimize=True)
    return buf.getvalue()
