#!/usr/bin/env python3
"""Einzelne Seiten durchleuchten: welches Rechteck faellt warum weg?

Die Kennzahlen aus `bildauswertung.py` sagen, dass etwas nicht stimmt. Dieses
Werkzeug sagt, warum — je Seite, je Rechteck, mit den Werten, an denen die
Regeln haengen.

Aufruf (kanonische Seitenzahlen, 0-basiert):
    .venv/bin/python tools/bilddiagnose.py 5 9 41
"""

from __future__ import annotations

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdfplumber  # noqa: E402

from extractor import image_regions as ir  # noqa: E402

WURZEL = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HEFTE = os.environ.get("HEFTE_DIR") or os.path.join(WURZEL, "hefte test")
INNEN = os.path.join(HEFTE, "zuerst 3-2026 innenteil.pdf")

# Kanonisch 2..81 sind die Innenteilseiten; davor liegen U1 und U2.
VERSATZ = 2


def main() -> int:
    if not os.path.exists(INNEN):
        print("Testheft fehlt", file=sys.stderr)
        return 2
    kanonisch = [int(a) for a in sys.argv[1:]] or [0, 5, 9, 41]
    karte = [(k - VERSATZ, k) for k in kanonisch if k >= VERSATZ]
    if not karte:
        print("Nur Innenteilseiten (kanonisch >= 2)", file=sys.stderr)
        return 2

    daten = open(INNEN, "rb").read()
    roh, trims = ir.read_raw_images(daten, karte)
    with pdfplumber.open(io.BytesIO(daten)) as pdf:
        for quelle, seite in karte:
            p = pdf.pages[quelle]
            worte = [
                (w["x0"] / p.width, w["top"] / p.height, w["x1"] / p.width,
                 w["bottom"] / p.height)
                for w in p.extract_words(extra_attrs=["size"])
                if float(w.get("size", 0) or 0) >= 4.5
            ]
            trim = trims[seite]
            netto = max(ir.area(trim), 1e-6)
            print(f"=== kanonisch {seite} (Quellseite {quelle})")
            for bild in roh[seite]:
                rect = ir.intersect(bild.rect, trim)
                flaeche = ir.area(rect)
                dichte = ir.text_density(rect, worte)
                streuung = ir.text_spread(rect, worte)
                gruende = []
                if bild.stencil:
                    gruende.append("Stempelmaske")
                breite, hoehe = rect[2] - rect[0], rect[3] - rect[1]
                if flaeche < ir.MIN_AREA:
                    gruende.append(f"zu klein {flaeche:.4f}")
                if min(breite, hoehe) < ir.MIN_SIDE:
                    gruende.append(f"Kante {min(breite, hoehe):.3f}")
                elif max(breite, hoehe) / min(breite, hoehe) > ir.MAX_ASPECT:
                    gruende.append("Streifen")
                if bild.source_px and bild.source_px < ir.MIN_SOURCE_PX:
                    gruende.append(f"Quelle {bild.source_px}px")
                if flaeche / netto > ir.BACKGROUND_AREA and dichte > ir.BACKGROUND_TEXT:
                    gruende.append("Hintergrund")
                if dichte > ir.TEXT_DENSITY_DROP and streuung > ir.TEXT_SPREAD_DROP:
                    gruende.append("Satzspiegel")
                lage = " ".join(f"{v:.3f}" for v in rect)
                print(
                    f"   [{lage}] Flaeche {flaeche:.4f} Dichte {dichte:.3f} "
                    f"Streuung {streuung:.2f} "
                    + ("VERWORFEN: " + ", ".join(gruende) if gruende else "behalten")
                )
            behalten = ir.select_regions(roh[seite], worte, trim)
            print(f"   -> {len(behalten)} Bildbereiche")
    return 0


if __name__ == "__main__":
    sys.exit(main())
