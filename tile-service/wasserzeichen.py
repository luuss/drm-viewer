"""Unsichtbares Wasserzeichen: wer hat diese Seite gelesen?

Jede Lesesitzung bekommt eine Kennung (`readerSessions.wasserzeichenCode`,
Zuordnung in der Tabelle `wasserzeichen`). Daraus werden 64 Bit, mit einem
Schluessel verschluesselt, den nur dieses Gateway kennt: von aussen ist es
Zufall, erst `python wasserzeichen.py lesen <bild>` macht daraus wieder Konto,
Heft und Datum.

Einbetten (Spreizspektrum): 64 geheime +-1-Muster auf einem 64x64-Raster,
eines je Bit. Die Summe, mit dem Vorzeichen des Bits gewichtet, liegt als
weiches Helligkeitsfeld ueber der ganzen Seite. Das Feld haengt an
Seitenkoordinaten, nicht an Kacheln: jede Kachel jeder Zoomstufe traegt ihren
Teil, und eine zusammengesetzte Seite oder ein Bildschirmfoto der ganzen Seite
traegt das ganze Feld. Wo die Seite leer ist, wird es fast nicht eingebracht,
damit auf weissem Papier nichts zu sehen ist.

Auslesen: auf ein festes Mass bringen, grobe Helligkeit abziehen, mit jedem
Muster vergleichen; das Vorzeichen ist das Bit. Uebersteht JPEG und
Skalieren; ein Ausschnitt muss die ganze Seite zeigen (siehe `lesen`).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import struct
import zlib

import numpy as np
from PIL import Image, ImageFilter

RASTER = int(os.environ.get("WASSERZEICHEN_RASTER", "64"))
BITS = 64
STAERKE = float(os.environ.get("WASSERZEICHEN_STAERKE", "2.0"))
# Grundanteil auch auf ruhigen Flaechen (0..1).
BODEN = float(os.environ.get("WASSERZEICHEN_BODEN", "0.15"))


def _schluessel() -> bytes:
    eigen = os.environ.get("WASSERZEICHEN_KEY", "")
    if eigen:
        return eigen.encode()
    basis = os.environ.get("TILE_SERVICE_SECRET", "")
    if not basis:
        raise RuntimeError("WASSERZEICHEN_KEY oder TILE_SERVICE_SECRET fehlt")
    return hmac.new(basis.encode(), b"wasserzeichen", hashlib.sha256).digest()


# --- 64 Bit verschluesseln (Feistel, 6 Runden, HMAC als Rundenfunktion) -------


def _runde(k: bytes, i: int, halb: int) -> int:
    d = hmac.new(k, struct.pack(">BI", i, halb), hashlib.sha256).digest()
    return struct.unpack(">I", d[:4])[0]


def verschluesseln(code: int, tag: int) -> int:
    """code: 32 Bit, tag: Tage seit 2020-01-01 (16 Bit). 16 Bit Pruefsumme."""
    pruef = zlib.crc32(struct.pack(">IH", code, tag)) & 0xFFFF
    klar = (code << 32) | (tag << 16) | pruef
    l, r = klar >> 32, klar & 0xFFFFFFFF
    k = _schluessel()
    for i in range(6):
        l, r = r, l ^ _runde(k, i, r)
    return (l << 32) | r


def entschluesseln(wert: int) -> tuple[int, int] | None:
    l, r = wert >> 32, wert & 0xFFFFFFFF
    k = _schluessel()
    for i in reversed(range(6)):
        l, r = r ^ _runde(k, i, l), l
    klar = (l << 32) | r
    code, tag, pruef = klar >> 32, (klar >> 16) & 0xFFFF, klar & 0xFFFF
    if zlib.crc32(struct.pack(">IH", code, tag)) & 0xFFFF != pruef:
        return None
    return code, tag


def _weich(arr: np.ndarray, radius: float) -> np.ndarray:
    """Gauss-Weichzeichner ueber ein 8-Bit-Graubild (Pillow kann es nur so)."""
    bild = Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8), "L")
    return np.asarray(bild.filter(ImageFilter.GaussianBlur(radius)), np.float32)


# --- Muster ---------------------------------------------------------------------

_muster: np.ndarray | None = None


def muster() -> np.ndarray:
    """64 geheime +-1-Raster, aus dem Schluessel abgeleitet."""
    global _muster
    if _muster is None:
        seed = int.from_bytes(hmac.new(_schluessel(), b"muster", hashlib.sha256).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        _muster = rng.choice([-1.0, 1.0], size=(BITS, RASTER, RASTER)).astype(np.float32)
    return _muster


def feld(wert: int) -> Image.Image:
    """Summe der Muster mit dem Vorzeichen der Bits, Standardabweichung 1."""
    bits = np.array([(wert >> (BITS - 1 - i)) & 1 for i in range(BITS)], np.float32) * 2 - 1
    summe = np.tensordot(bits, muster(), axes=1) / np.sqrt(BITS)
    return Image.fromarray(summe.astype(np.float32), "F")


def einbetten(bild: Image.Image, f: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    """Feld in einen Ausschnitt der Seite legen.

    box: der Ausschnitt in Seitenkoordinaten 0..1 (x0, y0, x1, y1). Fuer ein
    ganzes Bild (0, 0, 1, 1).
    """
    w, h = bild.size
    if w < 32 or h < 32:
        return bild
    x0, y0, x1, y1 = (v * RASTER for v in box)
    teil = np.asarray(
        f.transform((w, h), Image.Transform.EXTENT, (x0, y0, x1, y1), Image.Resampling.BICUBIC),
        np.float32,
    )
    rgb = np.asarray(bild.convert("RGB"), np.float32)
    grau = rgb.mean(axis=2)
    # Nur wo Inhalt ist: lokale Unruhe (Abweichung vom weichgezeichneten Bild).
    unruhe = _weich(np.abs(grau - _weich(grau, 3)), 6)
    maske = np.clip(unruhe / 12.0, BODEN, 1.0)
    neu = rgb + (STAERKE * teil * maske)[:, :, None]
    return Image.fromarray(np.clip(neu + 0.5, 0, 255).astype(np.uint8), "RGB")


def _phasenkorrelation(fund: np.ndarray, orig: np.ndarray) -> tuple[float, float, float]:
    """Spitze und Verschiebung (dx, dy, Subpixel) des Originals im Fundbild."""
    fh, fw = fund.shape
    oh, ow = orig.shape
    hoch, weit = fh + oh, fw + ow
    a = np.zeros((hoch, weit), np.float32)
    b = np.zeros((hoch, weit), np.float32)
    a[:fh, :fw] = fund - fund.mean()
    b[:oh, :ow] = orig - orig.mean()
    kreuz = np.fft.rfft2(a) * np.conj(np.fft.rfft2(b))
    kreuz /= np.abs(kreuz) + 1e-9
    flaeche = np.fft.irfft2(kreuz, s=(hoch, weit))
    y, x = np.unravel_index(int(np.argmax(flaeche)), flaeche.shape)
    spitze = float(flaeche[y, x])

    def fein(m1: float, m0: float, p1: float) -> float:
        n = m1 - 2 * m0 + p1
        return 0.0 if abs(n) < 1e-12 else 0.5 * (m1 - p1) / n

    dy = y + fein(flaeche[y - 1, x], flaeche[y, x], flaeche[(y + 1) % hoch, x])
    dx = x + fein(flaeche[y, x - 1], flaeche[y, x], flaeche[y, (x + 1) % weit])
    if dy > hoch / 2:
        dy -= hoch
    if dx > weit / 2:
        dx -= weit
    return spitze, dx, dy


def ausrichten(bild: Image.Image, original: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Fundbild auf die Originalseite zurueckrechnen.

    Ein Bildschirmfoto ist nie pixelgenau: Rand dabei, Seite angeschnitten,
    anders skaliert. Erst grob (256 px, Massstab in 1-%-Schritten), dann fein
    (768 px, 0,2 %), die Verschiebung je Massstab per Phasenkorrelation mit
    Subpixel. Ergebnis: das Fundbild im Koordinatensystem des Originals und
    eine Maske, wo es Daten hat.
    """
    wo, ho = original.size

    def suche(breite: int, massstaebe) -> tuple[float, float, float, float]:
        fund = np.asarray(
            bild.convert("L").resize((breite, max(1, round(bild.height * breite / bild.width)))),
            np.float32,
        )
        beste = (-1.0, 1.0, 0.0, 0.0)
        for m in massstaebe:
            ow = max(8, round(breite * m))
            oh = max(8, round(ho * ow / wo))
            orig = np.asarray(original.convert("L").resize((ow, oh)), np.float32)
            spitze, dx, dy = _phasenkorrelation(fund, orig)
            if spitze > beste[0]:
                beste = (spitze, ow / breite, dx / breite, dy / breite)
        return beste

    _, m, _, _ = suche(256, np.arange(0.5, 1.3001, 0.01))
    _, m, dx, dy = suche(768, np.arange(m - 0.012, m + 0.0121, 0.002))
    # In Fundbild-Breiten: das Original ist m breit und liegt bei (dx, dy).
    f = bild.width
    daten = (m * f / wo, 0, dx * f, 0, m * f / wo, dy * f)
    zurueck = bild.convert("RGB").transform((wo, ho), Image.Transform.AFFINE, daten, Image.Resampling.BICUBIC)
    maske = Image.new("L", bild.size, 255).transform((wo, ho), Image.Transform.AFFINE, daten)
    return zurueck, maske


def lesen(bild: Image.Image, original: Image.Image | None = None) -> tuple[int, float, np.ndarray]:
    """Wert, Sicherheit (mittlerer Betrag der Korrelation; ohne Zeichen ~1)
    und die Korrelation je Bit (fuer `kandidaten`).

    Mit `original` (die saubere Seite bzw. das saubere Artikelbild aus dem
    Medienspeicher) wird es genau: das Fundbild wird darauf ausgerichtet, das
    Original abgezogen, uebrig bleibt fast nur das Wasserzeichen. Ohne
    Original nur ein grober Versuch.
    """
    groesse = 512
    z = groesse // RASTER

    def grau(b: Image.Image) -> np.ndarray:
        return np.asarray(b.convert("L").resize((groesse, groesse), Image.Resampling.BICUBIC), np.float32)

    gueltig = np.ones((groesse, groesse), np.float32)
    if original is not None:
        zurueck, maske = ausrichten(bild, original)
        gueltig = (grau(maske) > 250).astype(np.float32)
        o = grau(original)
        rest = grau(zurueck) - o
        # Inhaltsrest herausrechnen: Anzeige und Bildschirmfoto glaetten die
        # Schrift anders als unser Verkleinern. Dieser Rest haengt am Inhalt,
        # das Wasserzeichen nicht; eine Ausgleichsrechnung gegen das Original
        # und weichgezeichnete Varianten davon nimmt ihn heraus.
        merkmale = [o, _weich(o, 1), _weich(o, 2), _weich(o, 4), np.ones_like(o)]
        A = np.stack([mm[gueltig > 0] for mm in merkmale], axis=1)
        koeff, *_ = np.linalg.lstsq(A, rest[gueltig > 0], rcond=None)
        if os.environ.get("WZ_OHNE_AUSGLEICH") != "1":
            rest = rest - sum(k * mm for k, mm in zip(koeff, merkmale))
        rest = rest * gueltig
    else:
        g = grau(bild)
        rest = g - _weich(g, 24)
    # Je Rasterzelle mitteln: das Feld ist innerhalb einer Zelle fast gleich.
    # (Keine Gewichtung nach Unruhe: das Feld sitzt gerade dort, wo Inhalt ist.)
    summe = rest.reshape(RASTER, z, RASTER, z).sum(axis=(1, 3))
    anzahl = gueltig.reshape(RASTER, z, RASTER, z).sum(axis=(1, 3))
    zellen = np.where(anzahl > 0, summe / np.maximum(anzahl, 1), 0.0)
    da = anzahl > 0
    # Flaechige Stoerungen (Hover-Toenung, Helligkeit, Farbprofil) sind ueber
    # viele Zellen gleich, das Feld wechselt von Zelle zu Zelle: Median der
    # 5x5-Nachbarschaft abziehen.
    rand = np.pad(zellen, 2, mode="edge")
    fenster = np.lib.stride_tricks.sliding_window_view(rand, (5, 5))
    zellen = np.where(da, zellen - np.median(fenster, axis=(2, 3)), 0.0)
    zellen[da] = (zellen[da] - zellen[da].mean()) / (zellen[da].std() + 1e-6)
    m = muster()
    korr = np.tensordot(m, zellen, axes=([1, 2], [0, 1])) / (RASTER * RASTER)
    wert = 0
    for k in korr:
        wert = (wert << 1) | int(k > 0)
    return wert, float(np.abs(korr).mean() * RASTER), korr


def kandidaten(wert: int, korr: np.ndarray, schwache: int = 12):
    """Gelesener Wert, dann Varianten mit gekippten unsicheren Bits.

    Liefert (wert, gekippte Bits) fuer jede Variante, deren Pruefsumme passt.
    Bei 12 unsicheren Bits sind es 4096 Versuche; die 16-Bit-Pruefsumme laesst
    dabei gelegentlich einen Zufallstreffer durch, darum zaehlt ein Treffer
    erst, wenn die Kennung auch in der Datenbank steht (Zufall: weniger als
    1 zu 10.000.000 bei 100.000 Kennungen).
    """
    unsicher = np.argsort(np.abs(korr))[:schwache]
    for maske in range(1 << schwache):
        w = wert
        for j, bit in enumerate(unsicher):
            if maske >> j & 1:
                w ^= 1 << (BITS - 1 - int(bit))
        if entschluesseln(w) is not None:
            yield w, bin(maske).count("1")


# --- Werkzeug ---------------------------------------------------------------------
#
# Im Gateway-Container, weil nur dort Schluessel und Medienspeicher sind:
#   docker cp fund.jpg code-tile-service-1:/tmp/fund.jpg
#   docker exec code-tile-service-1 python wasserzeichen.py /tmp/fund.jpg --heft <id> --seite <n>
#   docker exec code-tile-service-1 python wasserzeichen.py /tmp/fund.jpg --asset <assetId>
# Bequemer von aussen: tools/wasserzeichen-lesen.sh


async def _werkzeug(argv: list[str]) -> int:
    import argparse
    import io

    import main

    ap = argparse.ArgumentParser(description="Wasserzeichen aus einem gefundenen Bild lesen")
    ap.add_argument("bild")
    ap.add_argument("--heft", help="Heft-ID (Seite: mit --seite, Index ab 0)")
    ap.add_argument("--seite", type=int)
    ap.add_argument("--asset", help="Asset-ID eines Artikelbilds")
    a = ap.parse_args(argv)

    if a.asset:
        info = await main.service_call("/service/asset/resolve", {"assetId": a.asset})
        daten = await main.fetch_object(info.get("url"), info.get("bucket"), info.get("key"))
        original = Image.open(io.BytesIO(daten)).convert("RGB")
    elif a.heft is not None and a.seite is not None:
        original, _ = await main.load_page(a.heft, a.seite)
    else:
        ap.error("--heft und --seite oder --asset angeben")

    wert, sicherheit, korr = lesen(Image.open(a.bild), original)
    print(f"Sicherheit {sicherheit:.2f} (ohne Wasserzeichen etwa 1, sicher ab etwa 3)")
    gefunden = 0
    for w, gekippt in kandidaten(wert, korr):
        code, tag = entschluesseln(w)
        wer = await main.service_call("/service/wasserzeichen/resolve", {"code": code})
        if not wer:
            continue
        gefunden += 1
        print(
            f"Gelesen von {wer.get('email')} (Konto {wer.get('userId')}), "
            f"Heft {wer.get('heft')}, Sitzung {wer.get('gelesenAm')}, "
            f"Kennung {code}, korrigierte Bits {gekippt}"
        )
    if not gefunden:
        print("Kein Wasserzeichen gefunden.")
    return 0 if gefunden else 1


if __name__ == "__main__":
    import asyncio
    import sys

    sys.exit(asyncio.run(_werkzeug(sys.argv[1:])))
