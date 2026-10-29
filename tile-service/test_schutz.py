"""Verwuerfeln: die numpy-Fassung rechnet Pixel fuer Pixel wie die alte.

Der Reader setzt die Bloecke zusammen (`web/src/reader/schutz.ts`); weicht der
Server um ein Pixel ab, sieht der Leser Zeichensalat statt Bild.
"""

import time

import numpy as np
from PIL import Image, ImageOps

import schutz
from schutz import BLOCK, umformungen, vertauschung

_DREHUNG = {
    1: Image.Transpose.ROTATE_90,
    2: Image.Transpose.ROTATE_180,
    3: Image.Transpose.ROTATE_270,
}


def _baender(block, zeilen, spalten):
    for i in range(BLOCK // 8):
        if zeilen >> i & 1:
            box = (0, i * 8, BLOCK, i * 8 + 8)
            block.paste(ImageOps.invert(block.crop(box)), box[:2])
    for i in range(BLOCK // 8):
        if spalten >> i & 1:
            box = (i * 8, 0, i * 8 + 8, BLOCK)
            block.paste(ImageOps.invert(block.crop(box)), box[:2])
    return block


def verwuerfeln_alt(image, seed):
    """Die Fassung bis Oktober 2026, Block fuer Block mit Pillow."""
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


def _bild(breite, hoehe, modus="RGB", saat=1):
    rng = np.random.default_rng(saat)
    form = (hoehe, breite, 3) if modus == "RGB" else (hoehe, breite)
    return Image.fromarray((rng.random(form) * 255).astype(np.uint8), modus)


def test_gleich_wie_die_alte_fassung():
    # Kachel, Artikelbild mit Randstreifen, Hochformat, Graustufen.
    for breite, hoehe, modus, saat in [
        (512, 512, "RGB", 1),
        (1600, 1067, "RGB", 2),
        (700, 1013, "RGB", 3),
        (300, 200, "L", 4),
    ]:
        bild = _bild(breite, hoehe, modus, saat)
        for seed in (0, 12345, 0xFFFFFFFF):
            neu = np.asarray(schutz.verwuerfeln(bild, seed))
            alt = np.asarray(verwuerfeln_alt(bild, seed))
            assert neu.shape == alt.shape
            assert np.array_equal(neu, alt), (breite, hoehe, modus, seed)


def test_zu_kleine_bilder_bleiben():
    bild = _bild(100, 60)
    assert schutz.verwuerfeln(bild, 7) is bild


def test_schnell_genug_fuer_bildreiche_artikel():
    # Im Vergleich zur alten Fassung gemessen, nicht gegen die Uhr: auf einem
    # ausgelasteten Rechner werden beide langsamer (lokal ~50 statt ~330 ms).
    bild = _bild(1600, 1200)

    def dauer(verfahren):
        start = time.perf_counter()
        verfahren(bild, 99)
        return time.perf_counter() - start

    assert dauer(schutz.verwuerfeln) * 2 < dauer(verwuerfeln_alt)
