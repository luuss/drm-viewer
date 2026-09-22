#!/usr/bin/env python3
"""Einen Heftordner auswerten, ohne Server.

Nimmt den Ordner, wie die Druckvorstufe ihn liefert, und zeigt, was der Import
daraus machen wuerde: Artikel mit Ueberschrift, Seiten und Laenge, dazu Bilder,
Inhaltsverzeichnis und die Angaben aus dem Impressum.

    scripts/heft-pruefen.py "_scratch/hefte/dmz 170, innenteil + titelseite"
    scripts/heft-pruefen.py <ordner> --artikel 5      # Volltext eines Artikels
    scripts/heft-pruefen.py <ordner> --json bericht.json

Gerendert wird nichts und hochgeladen erst recht nicht. Das Werkzeug dient dem
Nachmessen: stimmen die Artikelgrenzen, sitzen die Bilder, greift das Profil.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
sys.path.insert(0, str(HIER.parent / "extract-service"))

from extractor.article_assembler import assemble, flow_text_blocks  # noqa: E402
from extractor.idml_articles import (  # noqa: E402
    artikel_aus_satz,
    ohne_unterlagen,
    rollen_je_story,
)
from extractor.idml_extract import (  # noqa: E402
    extract_idml_blocks,
    extract_idml_frames,
    frames_to_blocks,
    frames_to_images,
    idml_reading_order,
    toc_from_idml,
)
from extractor.image_regions import read_trim_boxes  # noqa: E402
from extractor.issue_meta import read_issue_meta  # noqa: E402
from extractor.pdf_extract import (  # noqa: E402
    attach_captions,
    extract_pdf_pages,
    mark_furniture,
    prepare_blocks,
)
from extractor.publication_profiles import apply_profile  # noqa: E402
import render  # noqa: E402


BILD = (".tif", ".tiff", ".jpg", ".jpeg", ".png")


def ordner_lesen(pfad: Path) -> dict:
    """Die Rollen im Heftordner bestimmen — dieselbe Einteilung wie im Browser."""
    plan = {"inner": None, "cover": None, "idml": None, "titel": None, "links": []}
    for eintrag in sorted(pfad.iterdir()):
        name = eintrag.name.lower()
        if eintrag.is_dir():
            if eintrag.name.lower() == "links":
                plan["links"] = [
                    p for p in sorted(eintrag.iterdir()) if p.suffix.lower() in BILD
                ]
            continue
        if name.startswith(".") or name.endswith(".indd"):
            continue
        if name.endswith(".pdf"):
            if "umschlag" in name or ("titel" in name and "innen" not in name):
                plan["cover"] = plan["cover"] or eintrag
            else:
                plan["inner"] = plan["inner"] or eintrag
        elif name.endswith(".idml"):
            if plan["idml"] is None or eintrag.stat().st_size > plan["idml"].stat().st_size:
                plan["idml"] = eintrag
        elif name.endswith(BILD):
            if plan["titel"] is None or eintrag.suffix.lower() in (".tif", ".tiff"):
                plan["titel"] = eintrag
    if plan["inner"] is None and plan["cover"] is not None:
        plan["inner"], plan["cover"] = plan["cover"], None
    return plan


def auswerten(pfad: Path, slug: str | None, gedruckt_ab: int = 3) -> dict:
    plan = ordner_lesen(pfad)
    if plan["inner"] is None:
        raise SystemExit(f"Kein Innenteil-PDF in {pfad}")

    pdf_bytes = plan["inner"].read_bytes()
    seitenzahl = render.page_count(pdf_bytes)
    # Kanonische Seiten: eine Titelseite davor, dann der Innenteil.
    versatz = 1 if plan["titel"] is not None else 0
    page_map = [(i, i + versatz) for i in range(seitenzahl)]
    pages = [{"index": 0, "role": "front_cover", "printedLabel": "U1"}] if versatz else []
    pages += [
        {"index": i + versatz, "role": "content", "printedLabel": str(i + gedruckt_ab)}
        for i in range(seitenzahl)
    ]

    blocks, images = [], []
    aus_satz = False
    if plan["idml"] is not None:
        idml_bytes = plan["idml"].read_bytes()
        bildrahmen, textrahmen = extract_idml_frames(idml_bytes)
        trims = read_trim_boxes(pdf_bytes, page_map, None)
        rohe = extract_idml_blocks(idml_bytes, textrahmen)
        blocks = frames_to_blocks(rohe, page_map, trims)
        images = frames_to_images(
            ohne_unterlagen(bildrahmen, textrahmen, rollen_je_story(rohe)),
            page_map,
            trims,
        )
        aus_satz = bool(blocks)
    if not aus_satz:
        blocks, images = extract_pdf_pages(pdf_bytes, page_map, None)

    satz_toc = (
        toc_from_idml([b for b in blocks if b.origin == "idml"], gedruckt_ab - versatz)
        if aus_satz
        else []
    )
    blocks, images, toc = apply_profile(blocks, images, pages, slug)
    if satz_toc:
        toc = satz_toc
    if aus_satz:
        mark_furniture(blocks, len(pages))
        geordnet = [b for b in blocks if not b.drop]
        attach_captions(images, idml_reading_order(geordnet))
        # Wie im Worker: die Stories des Satzes sind die Artikel.
        artikel = artikel_aus_satz(geordnet, images)
    else:
        geordnet = prepare_blocks(blocks, images, len(pages))
        artikel = assemble(geordnet, images, toc_hints=toc)
    meta = read_issue_meta(pdf_bytes)

    return {
        "ordner": pfad.name,
        "quelle": "satz" if aus_satz else "pdf",
        "dateien": {
            "innenteil": plan["inner"].name,
            "umschlag": plan["cover"].name if plan["cover"] else None,
            "satzdatei": plan["idml"].name if plan["idml"] else None,
            "titelseite": plan["titel"].name if plan["titel"] else None,
            "bilder": len(plan["links"]),
        },
        "seiten": len(pages),
        "bloecke": len(geordnet),
        "bildbereiche": len(images),
        "inhaltsverzeichnis": len(toc),
        "impressum": meta,
        "artikel": [
            {
                "order": i + 1,
                "titel": a.title,
                "untertitel": a.subtitle,
                "autor": a.author,
                "seiten": [a.pages[0] + 1, a.pages[-1] + 1],
                "zeichen": sum(len(b.text) for b in a.blocks),
                "bilder": len(a.images),
                "confidence": round(a.confidence, 2),
                "herkunft": a.source,
                "text": "\n\n".join(b.text for b in flow_text_blocks(a.blocks)),
            }
            for i, a in enumerate(artikel)
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Heftordner auswerten")
    ap.add_argument("ordner", nargs="+")
    ap.add_argument("--slug", help="Kennung der Reihe fuer das Publikationsprofil")
    ap.add_argument(
        "--ab", type=int, default=3, help="Seitenzahl der ersten Innenseite (Vorgabe 3)"
    )
    ap.add_argument("--artikel", type=int, help="Volltext dieses Artikels zeigen")
    ap.add_argument("--json", help="Bericht als JSON schreiben")
    args = ap.parse_args()

    berichte = []
    for ordner in args.ordner:
        pfad = Path(ordner)
        slug = args.slug or slug_raten(pfad.name)
        bericht = auswerten(pfad, slug, args.ab)
        berichte.append(bericht)

        d = bericht["dateien"]
        print(f"\n=== {bericht['ordner']}")
        print(
            f"    Quelle: {bericht['quelle']} · {bericht['seiten']} Seiten · "
            f"{bericht['bloecke']} Bloecke · {bericht['bildbereiche']} Bildbereiche · "
            f"{bericht['inhaltsverzeichnis']} Inhaltseintraege"
        )
        print(
            f"    Dateien: {d['innenteil']} | Satz: {d['satzdatei']} | "
            f"Titel: {d['titelseite']} | {d['bilder']} Bilder"
        )
        if bericht["impressum"]:
            print(f"    Impressum: {bericht['impressum']}")
        print(f"    {len(bericht['artikel'])} Artikel:")
        for a in bericht["artikel"]:
            print(
                f"     #{a['order']:>3} S.{a['seiten'][0]:>3}-{a['seiten'][1]:<3} "
                f"{a['zeichen']:>6} Z. {a['bilder']:>2} B. {a['confidence']:.2f} "
                f"| {a['titel'][:64]}"
            )
        if args.artikel:
            treffer = next(
                (a for a in bericht["artikel"] if a["order"] == args.artikel), None
            )
            if treffer:
                print("\n--- Volltext ---")
                print(treffer["text"][:6000])

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(berichte, fh, ensure_ascii=False, indent=1)
        print(f"\ngeschrieben: {args.json}")
    return 0


def slug_raten(ordnername: str) -> str | None:
    """Aus dem Ordnernamen die Kennung der Reihe raten, wie im Importdialog."""
    n = ordnername.lower()
    if n.startswith("dmz-zeit") or "zeitgeschichte" in n:
        return "dmz-zeitgeschichte"
    if n.startswith("dmz"):
        return "dmz"
    if n.startswith("zuerst"):
        return "zuerst"
    if n.startswith("schwerter"):
        return "schwertertraeger"
    return None


if __name__ == "__main__":
    sys.exit(main())
