#!/usr/bin/env python3
"""Schriftzuege fuer die Marke Weltkrieg als SVG-Pfade (keine Schrift noetig im <img>).

Schrift: Anton (web/public/fonts/anton-normal-latin.woff2, SIL OFL), aehnlich dem
WELTKRIEG-Schriftzug im Kopfbild von weltkrieg-online.de.
Ausgabe: web/public/img/wk/*.svg. Aufruf: python3 tools/marke/wk_schriftzuege.py
Farben der Reihen = Menueleiste von weltkrieg-online.de (Stand 03.11.2026).
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

WEB = Path(__file__).resolve().parents[2] / "web" / "public"
font = TTFont(WEB / "fonts" / "anton-normal-latin.woff2")
cmap = font.getBestCmap()
gs = font.getGlyphSet()
hmtx = font["hmtx"]


def zeile(text, x0=0.0, spacing=0):
    """Pfad einer Textzeile in Font-Einheiten, y nach unten (SVG)."""
    teile, x = [], x0
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            continue
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        d = pen.getCommands()
        if d:
            teile.append(f'<path transform="translate({x:.1f},0) scale(1,-1)" d="{d}"/>')
        x += hmtx[name][0] + spacing
    return teile, x - x0 - spacing


def bounds(text):
    bp = BoundsPen(gs)
    for ch in text:
        gs[cmap[ord(ch)]].draw(bp)
    return bp.bounds


asc = font["OS/2"].sCapHeight or 1434


def svg(datei, zeilen, farbe_band=None, pad=60):
    """zeilen: Liste (text, farbe, groesse_relativ). Untereinander, linksbuendig."""
    gruppen, y, breite = [], 0, 0
    for text, farbe, s in zeilen:
        p, w = zeile(text)
        h = asc * s
        y += h
        gruppen.append(f'<g fill="{farbe}" transform="translate({pad},{y + pad:.0f}) scale({s})">{"".join(p)}</g>')
        y += asc * 0.22 * s
        breite = max(breite, w * s)
    y -= asc * 0.22 * zeilen[-1][2]
    W, H = breite + 2 * pad, y + 2 * pad
    band = f'<rect width="{W:.0f}" height="{H:.0f}" fill="{farbe_band}"/>' if farbe_band else ""
    (WEB / "img" / "wk" / datei).write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}">{band}{"".join(gruppen)}</svg>\n'
    )


# Marke: hell fuer die dunkle Kopfleiste, dunkel fuer hellen Grund
svg("weltkrieg-hell.svg", [("WELTKRIEG", "#ffffff", 1)], pad=20)
svg("weltkrieg-dunkel.svg", [("WELTKRIEG", "#111111", 1)], pad=20)

REIHEN = {
    "originalband": ("ORIGINALBAND", "#ec6708"),
    "doppelband": ("DOPPELBAND", "#22a636"),
    "grossband": ("GROSSBAND", "#e40613"),
    "flieger": ("FLIEGER", "#222a73"),
    "marine": ("MARINE", "#018ec3"),
    "soldaten": ("SOLDATEN", "#8a3b2c"),
    "magazin": ("MAGAZIN", "#edcd00"),
    "blitzkrieg": ("BLITZKRIEG", "#ec6708"),
    "freikorps": ("FREIKORPS", "#35532d"),
    "legion": ("LEGION", "#9f862a"),
}
for slug, (wort, farbe) in REIHEN.items():
    # Nur der Reihenname, ohne "WELTKRIEG" darueber: Kacheln im Kiosk, wo
    # die Marke schon im Kopf steht (Anweisung 05.11.2026).
    svg(f"reihe-{slug}-name.svg", [(wort, farbe, 1)])
    if slug in ("freikorps", "legion", "blitzkrieg"):
        # eigene Hefttitel ohne "Weltkrieg"
        svg(f"reihe-{slug}.svg", [(wort, farbe, 1)])
    else:
        svg(f"reihe-{slug}.svg", [("WELTKRIEG", "#111111", 1), (wort, farbe, 0.55)])
print("fertig")
