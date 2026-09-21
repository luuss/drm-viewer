#!/usr/bin/env python3
"""Umschlag-Bogen mit Klappe in vier Einzelseiten zerlegen.

Manche Umschlaege kommen aus der Druckvorstufe als Bogen mit drei Feldern:
aussen Klappe, U4, U1 und innen U2, U3, Klappe. Der Import kennt nur ganze
Bogen aus zwei Haelften oder vier Einzelseiten. Dieses Skript schneidet die
vier Umschlagseiten aus dem Bogen und schreibt sie in Bogenreihenfolge
(U4, U1, U2, U3), so dass die Datei mit `--umschlag-layout sheets` importiert
werden kann. Die Klappe faellt weg. Der Schnitt folgt der TrimBox, Druckmarken
und Anschnitt bleiben draussen; die Textebene bleibt erhalten.

Feld-Angabe je Umschlagseite als SEITE:FELD, beide ab 0, Felder von links.
Beispiel DMZ Zeitgeschichte (Klappe links am Ruecken):

    scripts/umschlag-zerlegen.py "DMZ-Zeit 80 Umschlag.pdf" umschlag-80.pdf \\
      --felder 3 --u4 0:1 --u1 0:2 --u2 1:0 --u3 1:1
"""

from __future__ import annotations

import argparse
import ctypes
import sys

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c


def trim_box(page) -> tuple[float, float, float, float]:
    """Netzformat der Seite (links, unten, rechts, oben): TrimBox, sonst CropBox, sonst MediaBox."""
    for getter in ("get_trimbox", "get_cropbox", "get_mediabox"):
        try:
            box = getattr(page, getter)()
        except Exception:
            continue
        if box and len(box) == 4:
            left, bottom, right, top = (float(v) for v in box)
            if right - left >= 1 and top - bottom >= 1:
                return left, bottom, right, top
    return 0.0, 0.0, float(page.get_width()), float(page.get_height())


def panel_box(page, panels: int, panel: int) -> tuple[float, float, float, float]:
    left, bottom, right, top = trim_box(page)
    width = (right - left) / panels
    return left + panel * width, bottom, left + (panel + 1) * width, top


def parse_spec(text: str) -> tuple[int, int]:
    page, _, panel = text.partition(":")
    return int(page), int(panel)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Umschlag-Bogen in vier Einzelseiten zerlegen",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("eingabe", help="Umschlag-PDF mit Bogen")
    parser.add_argument("ausgabe", help="Ziel-PDF mit vier Seiten U4, U1, U2, U3")
    parser.add_argument("--felder", type=int, default=3, help="Felder je Bogen (Standard 3)")
    parser.add_argument("--u1", default="0:2", help="Feld der Titelseite, SEITE:FELD")
    parser.add_argument("--u2", default="1:0", help="Feld von U2")
    parser.add_argument("--u3", default="1:1", help="Feld von U3")
    parser.add_argument("--u4", default="0:1", help="Feld der Rueckseite")
    args = parser.parse_args()

    source = pdfium.PdfDocument(args.eingabe)
    order = [("U4", args.u4), ("U1", args.u1), ("U2", args.u2), ("U3", args.u3)]
    specs = [(label, *parse_spec(spec)) for label, spec in order]
    for _, page_index, panel in specs:
        if not 0 <= page_index < len(source):
            raise SystemExit(f"Seite {page_index} gibt es nicht ({len(source)} Seiten)")
        if not 0 <= panel < args.felder:
            raise SystemExit(f"Feld {panel} gibt es nicht ({args.felder} Felder)")

    target = pdfium.PdfDocument.new()
    for label, page_index, panel in specs:
        target.import_pages(source, pages=[page_index])
        page = target[len(target) - 1]
        x0, y0, x1, y1 = panel_box(source[page_index], args.felder, panel)
        width, height = x1 - x0, y1 - y0
        # Inhalt so verschieben, dass das Feld im Ursprung liegt, und alles
        # ausserhalb des Feldes abschneiden.
        matrix = pdfium_c.FS_MATRIX(1, 0, 0, 1, -x0, -y0)
        clip = pdfium_c.FS_RECTF(0, height, width, 0)
        pdfium_c.FPDFPage_TransFormWithClip(page, ctypes.byref(matrix), ctypes.byref(clip))
        for setter in (
            page.set_mediabox,
            page.set_cropbox,
            page.set_bleedbox,
            page.set_trimbox,
            page.set_artbox,
        ):
            setter(0, 0, width, height)
        print(f"{label}: Seite {page_index}, Feld {panel}, {width / 72 * 25.4:.0f} x {height / 72 * 25.4:.0f} mm")
    target.save(args.ausgabe)
    print(f"geschrieben: {args.ausgabe}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
