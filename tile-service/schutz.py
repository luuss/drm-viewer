"""Kopierschutz: verwuerfelte Kacheln und Bilder, Schrift mit eigener Zeichentabelle.

Gegenstueck zu `convex/schutz.ts` (Text) und `web/src/reader/schutz.ts`
(Zusammensetzen im Browser). Die Zufallsfunktionen muessen dort und hier Bit
fuer Bit gleich rechnen; `convex/schutz.test.ts` prueft das.

Verwuerfeln: Ein Bild wird in Bloecke zu BLOCK Pixel geteilt, die vollen
Bloecke werden vertauscht. BLOCK ist ein Vielfaches von 8, und JPEG wird ohne
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


def verwuerfeln(image: Image.Image, seed: int) -> Image.Image:
    """Volle Bloecke vertauschen: Block k des Ergebnisses ist Block p[k] des Originals."""
    spalten = image.width // BLOCK
    zeilen = image.height // BLOCK
    n = spalten * zeilen
    if n < 2:
        return image
    p = vertauschung(n, seed)
    out = image.copy()
    for k in range(n):
        q = p[k]
        sx, sy = (q % spalten) * BLOCK, (q // spalten) * BLOCK
        dx, dy = (k % spalten) * BLOCK, (k // spalten) * BLOCK
        out.paste(image.crop((sx, sy, sx + BLOCK, sy + BLOCK)), (dx, dy))
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
