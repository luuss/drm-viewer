#!/usr/bin/env python3
"""Bildextraktion am echten Heft messen.

Zweck: die Bildbereiche eines ganzen Heftes durchzaehlen und die Fehlerarten
benennen, die der Auftraggeber sieht — Text im Ausschnitt, ganzseitige
Hintergruende, Dubletten, Schnipsel. Vorher/Nachher laesst sich damit
vergleichen, statt einzelne Seiten anzusehen.

Aufruf:
    .venv/bin/python tools/bildauswertung.py                    # Kennzahlen
    .venv/bin/python tools/bildauswertung.py --json neu.json    # Rohdaten sichern
    .venv/bin/python tools/bildauswertung.py --vergleich alt.json
    .venv/bin/python tools/bildauswertung.py --dump out/        # Ausschnitte ablegen

Vergleichswerte eines frueheren Standes entstehen so:

    mkdir -p _messung/alt
    git archive <rev> extract-service | tar -x -C _messung/alt --strip-components=1
    cp tools/bildauswertung.py _messung/alt/tools/
    cd _messung/alt && HEFTE_DIR="../../../hefte test" \
        ../../.venv/bin/python tools/bildauswertung.py --json ../vorher.json

Das Skript misst immer den Stand, aus dessen Ordner es laeuft; mitkopiert wird
nur das Skript selbst, damit beide Laeufe dieselben Kennzahlen bilden.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pdfplumber  # noqa: E402

import render  # noqa: E402
from extractor.article_assembler import assemble  # noqa: E402
from extractor.pdf_extract import extract_pdf_pages, prepare_blocks  # noqa: E402

WURZEL = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Fuer Vergleichslaeufe gegen einen aelteren Stand laesst sich der Ordner mit
# den Testheften ueber die Umgebung setzen.
HEFTE = os.environ.get("HEFTE_DIR") or os.path.join(WURZEL, "hefte test")
INNEN = os.path.join(HEFTE, "zuerst 3-2026 innenteil.pdf")
UMSCHLAG = os.path.join(HEFTE, "umschlag zuerst 3-2026.pdf")

# Bogenreihenfolge des Umschlags: U4, U1, U2, U3. Kanonisch gelesen wird
# U1, U2, Innenteil 1..80, U3, U4 — zusammen 84 Seiten.
UMSCHLAG_VORNE = [(1, 0), (2, 1)]
UMSCHLAG_HINTEN = [(3, 82), (0, 83)]
INNEN_MAP = [(i, i + 2) for i in range(80)]

VOLLSEITE = 0.80      # Flaechenanteil, ab dem ein Bild als Hintergrund gilt
DUBLETTE_IOU = 0.80   # Ueberdeckung, ab der zwei Ausschnitte dasselbe zeigen


def _wortkasten(
    pdf_bytes: bytes, seiten: list[tuple[int, int]]
) -> tuple[dict[int, list[tuple]], dict[int, list[tuple]]]:
    """Wortrechtecke je kanonischer Seite: alle, und nur die in Grundschrift.

    Die zweite Liste ist der Massstab fuer "Satzspiegel ueberdeckt". Eine Karte
    traegt viel Beschriftung, aber keinen Fliesstext; sie ist kein Fehler.
    """
    from collections import Counter

    roh: dict[int, tuple[list, float, float]] = {}
    gezaehlt: Counter = Counter()
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for quelle, kanonisch in seiten:
            if quelle >= len(pdf.pages):
                continue
            p = pdf.pages[quelle]
            worte = [
                w
                for w in p.extract_words(extra_attrs=["size"], keep_blank_chars=False)
                if float(w.get("size", 0) or 0) >= 4.5
            ]
            roh[kanonisch] = (worte, p.width, p.height)
            for w in worte:
                gezaehlt[round(float(w["size"]), 1)] += len(w["text"])
    grund = gezaehlt.most_common(1)[0][0] if gezaehlt else 10.0

    alle: dict[int, list[tuple]] = {}
    satz: dict[int, list[tuple]] = {}
    for kanonisch, (worte, breite, hoehe) in roh.items():
        a, s = [], []
        for w in worte:
            r = (w["x0"] / breite, w["top"] / hoehe, w["x1"] / breite, w["bottom"] / hoehe)
            a.append(r)
            if abs(float(w["size"]) - grund) < grund * 0.15:
                s.append(r)
        alle[kanonisch] = a
        satz[kanonisch] = s
    return alle, satz


def _flaeche(r) -> float:
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def _schnitt(a, b) -> float:
    return _flaeche(
        (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    )


def _iou(a, b) -> float:
    s = _schnitt(a, b)
    v = _flaeche(a) + _flaeche(b) - s
    return s / v if v > 0 else 0.0


def _streuung(r, worte, raster: int = 4) -> float:
    """Anteil der Rasterfelder eines Rechtecks, in denen Text liegt.

    Dichte allein unterscheidet eine ins Bild gesetzte Bildunterschrift nicht
    von einer Textspalte. Die Verteilung tut es.
    """
    breite, hoehe = r[2] - r[0], r[3] - r[1]
    if breite <= 0 or hoehe <= 0:
        return 0.0
    belegt = set()
    for w in worte:
        s = (max(r[0], w[0]), max(r[1], w[1]), min(r[2], w[2]), min(r[3], w[3]))
        if s[2] <= s[0] or s[3] <= s[1]:
            continue
        for zeile in range(
            min(raster - 1, int((s[1] - r[1]) / hoehe * raster)),
            min(raster - 1, int((s[3] - r[1]) / hoehe * raster)) + 1,
        ):
            for spalte in range(
                min(raster - 1, int((s[0] - r[0]) / breite * raster)),
                min(raster - 1, int((s[2] - r[0]) / breite * raster)) + 1,
            ):
                belegt.add((zeile, spalte))
    return len(belegt) / (raster * raster)


def sammeln() -> dict:
    innen = open(INNEN, "rb").read()
    umschlag = open(UMSCHLAG, "rb").read()

    bloecke, bilder = [], []
    for daten, karte in ((umschlag, UMSCHLAG_VORNE + UMSCHLAG_HINTEN), (innen, INNEN_MAP)):
        b, i = extract_pdf_pages(daten, karte)
        bloecke.extend(b)
        bilder.extend(i)

    worte, fliesstext = _wortkasten(umschlag, UMSCHLAG_VORNE + UMSCHLAG_HINTEN)
    w2, f2 = _wortkasten(innen, INNEN_MAP)
    worte.update(w2)
    fliesstext.update(f2)

    geordnet = prepare_blocks(bloecke, bilder, 84)
    artikel = assemble(geordnet, bilder)

    zeilen = []
    je_seite: dict[int, list[tuple]] = {}
    for nr, img in enumerate(bilder):
        je_seite.setdefault(img.page_index, []).append(
            (nr, (img.x0, img.y0, img.x1, img.y1))
        )

    for nr, img in enumerate(bilder):
        r = (img.x0, img.y0, img.x1, img.y1)
        fl = _flaeche(r)
        wortflaeche = sum(_schnitt(r, w) for w in worte.get(img.page_index, []))
        woerter_drin = sum(
            1
            for w in worte.get(img.page_index, [])
            if _schnitt(r, w) > _flaeche(w) * 0.8
        )
        dubletten = sum(
            1
            for anderer_nr, andere in je_seite[img.page_index]
            if anderer_nr != nr and _iou(r, andere) > DUBLETTE_IOU
        )
        zeilen.append(
            {
                "seite": img.page_index,
                "rechteck": [round(v, 4) for v in r],
                "flaeche": round(fl, 4),
                "textanteil": round(wortflaeche / fl, 4) if fl else 0.0,
                "woerter": woerter_drin,
                "fliessanteil": round(
                    sum(_schnitt(r, w) for w in fliesstext.get(img.page_index, [])) / fl, 4
                )
                if fl
                else 0.0,
                "streuung": round(_streuung(r, fliesstext.get(img.page_index, [])), 3),
                "dublette": dubletten > 0,
                "vollseite": fl > VOLLSEITE,
                "caption": bool(img.caption),
            }
        )

    ohne_bild = sum(1 for a in artikel if not a.images)
    # Wie gut sitzt die Zuordnung? Ein Bild gehoert zu dem Artikel, dessen Satz
    # in derselben Spalte steht und oben oder unten anstoesst.
    fremde_spalte = 0
    fern = 0
    for a in artikel:
        for img in a.images:
            breite = max(img.x1 - img.x0, 1e-6)
            ueber = 0.0
            abstand = 1e9
            for b in a.blocks:
                if b.page_index != img.page_index or b.kind == "caption":
                    continue
                ueber = max(ueber, min(1.0, (min(b.x1, img.x1) - max(b.x0, img.x0)) / breite))
                if b.y0 >= img.y1:
                    abstand = min(abstand, b.y0 - img.y1)
                elif b.y1 <= img.y0:
                    abstand = min(abstand, img.y0 - b.y1)
                else:
                    abstand = 0.0
            if ueber < 0.15:
                fremde_spalte += 1
            if abstand > 0.25:
                fern += 1
    return {
        "bilder": zeilen,
        "artikel": {
            "gesamt": len(artikel),
            "ohne_bild": ohne_bild,
            "mit_bild": len(artikel) - ohne_bild,
            "bilder_zugeordnet": sum(len(a.images) for a in artikel),
            "fremde_spalte": fremde_spalte,
            "fern": fern,
        },
        "seiten_mit_bild": len({z["seite"] for z in zeilen}),
    }


def kennzahlen(daten: dict) -> dict:
    z = daten["bilder"]
    n = len(z) or 1
    return {
        "Bilder gesamt": len(z),
        "Seiten mit Bild": daten["seiten_mit_bild"],
        "mittlere Flaeche (%)": round(100 * sum(x["flaeche"] for x in z) / n, 2),
        "Text im Ausschnitt (>3%)": sum(1 for x in z if x["textanteil"] > 0.03),
        "Text im Ausschnitt (>10%)": sum(1 for x in z if x["textanteil"] > 0.10),
        "Fliesstext im Ausschnitt (>3%)": sum(1 for x in z if x["fliessanteil"] > 0.03),
        "Fliesstext im Ausschnitt (>10%)": sum(1 for x in z if x["fliessanteil"] > 0.10),
        "Satzspiegel ueberdeckt": sum(
            1
            for x in z
            if x["fliessanteil"] > 0.07 and x["streuung"] > 0.45
        ),
        "Woerter ganz im Bild (>=5)": sum(1 for x in z if x["woerter"] >= 5),
        "Dubletten": sum(1 for x in z if x["dublette"]),
        "Vollseiten-Hintergrund": sum(1 for x in z if x["vollseite"]),
        "Schnipsel (<1% Flaeche)": sum(1 for x in z if x["flaeche"] < 0.01),
        "mit Bildunterschrift": sum(1 for x in z if x["caption"]),
        "Artikel gesamt": daten["artikel"]["gesamt"],
        "Artikel ohne Bild": daten["artikel"]["ohne_bild"],
        "Bilder an Artikeln": daten["artikel"]["bilder_zugeordnet"],
        "Zuordnung ohne Spaltenbezug": daten["artikel"].get("fremde_spalte", 0),
        "Zuordnung weit vom Text": daten["artikel"].get("fern", 0),
    }


def _dump(daten: dict, ziel: str) -> None:
    """Ausschnitte als JPEG ablegen, damit man sie ansehen kann."""
    os.makedirs(ziel, exist_ok=True)
    innen = open(INNEN, "rb").read()
    umschlag = open(UMSCHLAG, "rb").read()
    quelle = {k: ("u", v) for v, k in UMSCHLAG_VORNE + UMSCHLAG_HINTEN}
    quelle.update({k: ("i", v) for v, k in INNEN_MAP})
    seiten = sorted({z["seite"] for z in daten["bilder"]})
    cache: dict[int, bytes] = {}
    for s in seiten:
        art, index = quelle[s]
        cache[s] = render.render_page(umschlag if art == "u" else innen, index, 1400)[0]
    for i, z in enumerate(daten["bilder"]):
        try:
            aus = render.crop_region(cache[z["seite"]], *z["rechteck"])
        except Exception:
            continue
        name = f"s{z['seite']:02d}_{i:03d}_t{int(z['textanteil'] * 100):02d}.jpg"
        open(os.path.join(ziel, name), "wb").write(aus)
    print(f"{len(daten['bilder'])} Ausschnitte in {ziel}")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--json", help="Kennzahlen und Rohdaten hierhin schreiben")
    p.add_argument("--vergleich", help="fruehere JSON-Datei gegenrechnen")
    p.add_argument("--dump", help="Ausschnitte als JPEG in diesen Ordner legen")
    args = p.parse_args()

    if not os.path.exists(INNEN):
        print("Testheft fehlt", file=sys.stderr)
        return 2

    daten = sammeln()
    kz = kennzahlen(daten)

    if args.vergleich:
        alt = kennzahlen(json.load(open(args.vergleich)))
        breite = max(len(k) for k in kz)
        print(f"{'Kennzahl':<{breite}}  {'vorher':>8} {'nachher':>8} {'Delta':>8}")
        for k, v in kz.items():
            a = alt.get(k, 0)
            d = round(v - a, 2)
            print(f"{k:<{breite}}  {a:>8} {v:>8} {d:>+8}")
    else:
        breite = max(len(k) for k in kz)
        for k, v in kz.items():
            print(f"{k:<{breite}}  {v}")

    if args.json:
        json.dump(daten, open(args.json, "w"), indent=1)
        print(f"\ngeschrieben: {args.json}")
    if args.dump:
        _dump(daten, args.dump)
    return 0


if __name__ == "__main__":
    sys.exit(main())
