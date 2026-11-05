"""Seiten rendern und Titelbilder erzeugen.

Gerendert wird mit PDFium ueber `pypdfium2` (BSD/Apache). PyMuPDF steht unter
AGPL und ist damit fuer den proprietaeren Betrieb heikel; es kommt im
Produktionspfad nicht mehr vor.
"""

from __future__ import annotations

import io
import os

import pypdfium2 as pdfium
from PIL import Image, ImageCms

from extractor.page_geometry import visible_page_box

# Breite der abgelegten Seitenfassung. Daraus schneidet das Kachel-Gateway
# seine Kacheln; das reicht fuer scharfen Zoom auf Magazinseiten.
PAGE_WIDTH_PX = int(__import__("os").environ.get("PAGE_RENDER_WIDTH", "2400"))
PAGE_JPEG_QUALITY = int(__import__("os").environ.get("PAGE_JPEG_QUALITY", "88"))
COVER_WIDTH_PX = 900



# --- Farbe -------------------------------------------------------------------
# Druckdaten sind CMYK. `Image.convert("RGB")` rechnet dann mit der einfachen
# Formel ohne Profil: Rot und Haut zu bunt, Tiefen zu dunkel (ZUERST! 11/2026).
# Richtig: eingebettetes Profil, sonst FOGRA39 (ISO Coated v2), relativ
# farbmetrisch mit Tiefenkompensierung. Profil: colord-data, CC0-1.0.
_FOGRA39 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icc", "FOGRA39L_coated.icc")
_SRGB = ImageCms.createProfile("sRGB")


def als_rgb(image: Image.Image) -> Image.Image:
    """Ein Bild nach sRGB bringen; CMYK ueber Farbprofil statt Formel."""
    if image.mode != "CMYK":
        return image if image.mode == "RGB" else image.convert("RGB")
    kandidaten = []
    icc = image.info.get("icc_profile")
    if icc:
        try:
            p = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            if p.profile.xcolor_space.strip() == "CMYK":
                kandidaten.append(p)
        except Exception:
            pass
    if os.path.exists(_FOGRA39):
        kandidaten.append(_FOGRA39)
    # Ein Profil kann sich oeffnen lassen und trotzdem keine Umrechnung
    # hergeben; dann das naechste, zuletzt die einfache Formel. Ein einzelnes
    # Bild darf den Auftrag nicht anhalten.
    for quelle in kandidaten:
        try:
            if isinstance(quelle, str):
                quelle = ImageCms.ImageCmsProfile(quelle)
            # Adobe-JPEG speichert CMYK invertiert; Pillow dreht es beim Lesen schon um.
            return ImageCms.profileToProfile(
                image,
                quelle,
                _SRGB,
                renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
                outputMode="RGB",
                flags=0x2000,  # Tiefenkompensierung (cmsFLAGS_BLACKPOINTCOMPENSATION)
            )
        except (ImageCms.PyCMSError, OSError):
            continue
    return image.convert("RGB")

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
    image = als_rgb(Image.open(io.BytesIO(jpeg_bytes)))
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
    image = als_rgb(Image.open(io.BytesIO(jpeg_bytes)))
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


def render_image_page(image_bytes: bytes, width_px: int = PAGE_WIDTH_PX):
    """Eine Bilddatei als Druckseite ablegen — (jpeg_bytes, breite, hoehe).

    Manche Hefte kommen ohne Umschlag-PDF: die Titelseite liegt dann als Bild
    daneben. Sie wird wie eine gerenderte Seite behandelt, damit Reader,
    Kachel-Gateway und Titelbild nichts von dem Unterschied wissen muessen.
    Vergroessert wird nicht; ein kleines Original bleibt klein.
    """
    image = Image.open(io.BytesIO(image_bytes))
    image = als_rgb(image)
    if image.width > width_px:
        height = max(1, round(image.height * width_px / image.width))
        image = image.resize((width_px, height), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=PAGE_JPEG_QUALITY, optimize=True)
    return buf.getvalue(), image.width, image.height


def fit_image(image_bytes: bytes, max_edge: int = 1600, quality: int = 82) -> bytes:
    """Ein platziertes Bild auf Artikelgroesse bringen, ohne es zu beschneiden."""
    image = als_rgb(Image.open(io.BytesIO(image_bytes)))
    laengste = max(image.width, image.height)
    if laengste > max_edge:
        faktor = max_edge / laengste
        image = image.resize(
            (max(1, round(image.width * faktor)), max(1, round(image.height * faktor))),
            Image.LANCZOS,
        )
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def image_size(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as image:
        return image.width, image.height


# Zwei Artikelbilder gelten als dasselbe Bild, wenn ihre verkleinerten
# Graustufenfassungen sich kaum unterscheiden. An den vier Musterheften
# gemessen (2333 Paare innerhalb eines Artikels): dieselbe Vorlage ergibt 0,
# das aehnlichste Paar verschiedener Bilder — zwei Seiten desselben
# Schriftstuecks — 16.
SAME_PICTURE_EDGE = 32
SAME_PICTURE_RMS = 6.0
SAME_PICTURE_ASPECT = 0.03

Fingerprint = tuple[float, bytes]


def fingerprint(image_bytes: bytes) -> Fingerprint:
    """Seitenverhaeltnis und grobe Graustufenfassung eines Bildes."""
    with Image.open(io.BytesIO(image_bytes)) as image:
        verhaeltnis = image.width / max(1, image.height)
        klein = image.convert("L").resize(
            (SAME_PICTURE_EDGE, SAME_PICTURE_EDGE), Image.LANCZOS
        )
        return verhaeltnis, klein.tobytes()


def same_picture(a: Fingerprint, b: Fingerprint) -> bool:
    """Zeigen zwei Abdruecke dasselbe Bild?

    Das Seitenverhaeltnis zaehlt mit: einfarbige Flaechen verschiedener Form
    sehen verkleinert gleich aus.
    """
    if abs(a[0] - b[0]) > SAME_PICTURE_ASPECT * max(a[0], b[0]):
        return False
    quadrate = sum((x - y) ** 2 for x, y in zip(a[1], b[1]))
    return (quadrate / len(a[1])) ** 0.5 < SAME_PICTURE_RMS
