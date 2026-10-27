"""Kopierschutz: verwuerfelte Kacheln und Bilder, Schrift mit eigener Zeichentabelle.

Gegenstueck zu `convex/schutz.ts` (Text) und `web/src/reader/schutz.ts`
(Zusammensetzen im Browser). Die Zufallsfunktionen muessen dort und hier Bit
fuer Bit gleich rechnen; `convex/schutz.test.ts` prueft das.

Verwuerfeln: Ein Bild wird in Bloecke zu BLOCK Pixel geteilt, die vollen
Bloecke werden vertauscht, gedreht und mit invertierten Querstrichen versehen. BLOCK ist ein Vielfaches von 8, und JPEG wird ohne
Farbunterabtastung (4:4:4) gespeichert. Damit liegt jeder 8x8-Block des JPEG
ganz in einem Block, und nach dem Zuruecktauschen bleiben keine Naehte.
"""

from __future__ import annotations

import io
from collections import OrderedDict
from pathlib import Path

from PIL import Image

M32 = 0xFFFFFFFF
BLOCK = 64

SCHUTZ_ALPHABET = (
    "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`"
    "abcdefghijklmnopqrstuvwxyz{|}~¡¢£¤¥¦§¨©ª«¬®¯°±²³´¶·¸¹º»¼½¾¿"
    "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ"
    "–—‘’‚“”„…€•‹›"
)
SCHUTZ_PUA = 0xE000


def fnv1a32(text: str) -> int:
    h = 0x811C9DC5
    daten = text.encode("utf-16-le")
    for i in range(0, len(daten), 2):
        h ^= daten[i] | (daten[i + 1] << 8)
        h = (h * 0x01000193) & M32
    return h


def mulberry32(seed: int):
    a = seed & M32

    def weiter() -> int:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = ((a ^ (a >> 15)) * (1 | a)) & M32
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32) ^ t
        return (t ^ (t >> 14)) & M32

    return weiter


def vertauschung(n: int, seed: int) -> list[int]:
    p = list(range(n))
    r = mulberry32(seed)
    for i in range(n - 1, 0, -1):
        j = r() % (i + 1)
        p[i], p[j] = p[j], p[i]
    return p


def schrift_schluessel(seed: int) -> int:
    return fnv1a32(f"{seed}:schrift")


def kachel_schluessel(seed: int) -> int:
    return fnv1a32(f"{seed}:kacheln")


def umformungen(n: int, seed: int) -> list[tuple[int, int, int]]:
    """Je Block: Drehung (Viertel), Zeilenbaender, Spaltenbaender (je 8 Bit).

    Ein eigener Strom neben der Vertauschung, damit beide Stufen unabhaengig
    sind. Gegenstueck in `web/src/reader/schutz.ts` (`umformungen`).
    """
    r = mulberry32(seed ^ 0x9E3779B9)
    out = []
    for _ in range(n):
        out.append((r() % 4, r() & 0xFF, r() & 0xFF))
    return out


def _baender(block: Image.Image, zeilen: int, spalten: int) -> Image.Image:
    """Querstriche: 8-px-Baender invertieren, erst Zeilen, dann Spalten.

    Wo sich zwei Baender kreuzen, ist doppelt invertiert, also wieder normal.
    Die Baender liegen auf dem 8er-Raster des JPEG, darum ueberlebt das die
    Kompression ohne Naehte.
    """
    from PIL import ImageOps

    for i in range(BLOCK // 8):
        if zeilen >> i & 1:
            box = (0, i * 8, BLOCK, i * 8 + 8)
            block.paste(ImageOps.invert(block.crop(box)), box[:2])
    for i in range(BLOCK // 8):
        if spalten >> i & 1:
            box = (i * 8, 0, i * 8 + 8, BLOCK)
            block.paste(ImageOps.invert(block.crop(box)), box[:2])
    return block


_DREHUNG = {1: Image.Transpose.ROTATE_90, 2: Image.Transpose.ROTATE_180, 3: Image.Transpose.ROTATE_270}


def verwuerfeln(image: Image.Image, seed: int) -> Image.Image:
    """Zwei Stufen je vollem Block.

    1. Vertauschen: Block k des Ergebnisses ist Block p[k] des Originals.
    2. Den Block um 90°·d gegen den Uhrzeigersinn drehen und mit
       invertierten Querstrichen versehen.

    Der Reader macht es in umgekehrter Folge rueckgaengig.
    """
    spalten = image.width // BLOCK
    zeilen = image.height // BLOCK
    n = spalten * zeilen
    if n < 2:
        return image
    p = vertauschung(n, seed)
    formen = umformungen(n, seed)
    out = image.copy()
    for k in range(n):
        q = p[k]
        sx, sy = (q % spalten) * BLOCK, (q // spalten) * BLOCK
        dx, dy = (k % spalten) * BLOCK, (k // spalten) * BLOCK
        block = image.crop((sx, sy, sx + BLOCK, sy + BLOCK))
        drehung, zb, sb = formen[k]
        if drehung:
            block = block.transpose(_DREHUNG[drehung])
        out.paste(_baender(block, zb, sb), (dx, dy))
    return out


def als_jpeg(image: Image.Image, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    # 4:4:4, sonst verschmiert der Decoder die Farbe ueber Blockgrenzen.
    image.convert("RGB").save(buf, format="JPEG", quality=quality, subsampling=0)
    return buf.getvalue()


# --- Schrift -----------------------------------------------------------------

SCHRIFTEN_DIR = Path(__file__).with_name("fonts")
SCHRIFTEN = {
    "sans": "open-sans-normal-latin.woff2",
    "serif": "playfair-display-normal-latin.woff2",
    "serif-kursiv": "playfair-display-italic-latin.woff2",
}
_schrift_cache: "OrderedDict[tuple[int, str], bytes]" = OrderedDict()


def schrift(seed: int, familie: str) -> bytes:
    """WOFF2, deren Zeichentabelle nur die Plaetze der Lesesitzung kennt."""
    from fontTools.ttLib import TTFont

    schluessel = (seed, familie)
    if schluessel in _schrift_cache:
        _schrift_cache.move_to_end(schluessel)
        return _schrift_cache[schluessel]

    font = TTFont(SCHRIFTEN_DIR / SCHRIFTEN[familie])
    alt = font.getBestCmap()
    p = vertauschung(len(SCHUTZ_ALPHABET) * 2, schrift_schluessel(seed))
    neu = {cp: g for cp, g in alt.items() if chr(cp) not in SCHUTZ_ALPHABET}
    for i, zeichen in enumerate(SCHUTZ_ALPHABET):
        glyphe = alt.get(ord(zeichen))
        if glyphe is None:
            continue
        neu[SCHUTZ_PUA + p[2 * i]] = glyphe
        neu[SCHUTZ_PUA + p[2 * i + 1]] = glyphe
    for tabelle in font["cmap"].tables:
        if tabelle.isUnicode():
            tabelle.cmap = dict(neu)
    # Glyphennamen ("a", "germandbls") wuerden die Zuordnung verraten.
    font["post"].formatType = 3.0
    font["post"].extraNames = []
    font["post"].mapping = {}
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    daten = buf.getvalue()

    _schrift_cache[schluessel] = daten
    while len(_schrift_cache) > 64:
        _schrift_cache.popitem(last=False)
    return daten
