#!/usr/bin/env python3
"""Artikel aus einer InDesign-Satzdatei lesen — ohne Server, ohne PDF.

    scripts/satz-lesen.py <ordner-oder-idml> [...]        Uebersicht
    scripts/satz-lesen.py <...> --artikel 3               Volltext eines Artikels
    scripts/satz-lesen.py <...> --stories                 Stories statt Artikel
    scripts/satz-lesen.py <...> --json bericht.json       Bericht schreiben

Damit laesst sich pruefen, ob aus dem Satz wirklich jeder Absatz kommt, bevor
irgendetwas hochgeladen wird.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HIER = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HIER.parent / "extract-service"))

from extractor.idml_articles import artikel_aus_satz, stories_bilden  # noqa: E402
from extractor.idml_extract import (  # noqa: E402
    extract_idml_blocks,
    extract_idml_frames,
)


def satzdatei(ziel: pathlib.Path) -> pathlib.Path | None:
    if ziel.is_file() and ziel.suffix.lower() == ".idml":
        return ziel
    if ziel.is_dir():
        return next(iter(sorted(ziel.rglob("*.idml"))), None)
    return None


def auswerten(idml: pathlib.Path) -> dict:
    data = idml.read_bytes()
    bilder, texte = extract_idml_frames(data)
    blocks = extract_idml_blocks(data, text_frames=texte)
    artikel = artikel_aus_satz(blocks)
    zeichen_gesamt = sum(len(b.text) for b in blocks)
    zeichen_artikel = sum(len(b.text) for a in artikel for b in a.blocks)
    return {
        "datei": idml.name,
        "bloecke": len(blocks),
        "textrahmen": len(texte),
        "bildrahmen": len(bilder),
        "zeichen": zeichen_gesamt,
        "zeichenInArtikeln": zeichen_artikel,
        "artikel": artikel,
        "stories": stories_bilden(blocks),
    }


def zeige(bericht: dict, args) -> None:
    print(f"=== {bericht['datei']}")
    print(
        f"    {bericht['textrahmen']} Textrahmen · {bericht['bloecke']} Absaetze · "
        f"{bericht['zeichen']} Zeichen · {bericht['bildrahmen']} Bildrahmen"
    )
    artikel = bericht["artikel"]
    anteil = (
        100 * bericht["zeichenInArtikeln"] / bericht["zeichen"]
        if bericht["zeichen"]
        else 0
    )
    print(
        f"    {len(artikel)} Artikel, darin {bericht['zeichenInArtikeln']} Zeichen "
        f"({anteil:.0f} % des Satzes)"
    )
    if args.stories:
        for s in sorted(bericht["stories"], key=lambda s: (s.erste_seite, s.oben)):
            print(
                f"    {s.story_id:10} S{s.seiten[:5]!s:20} {s.rolle():14} "
                f"{s.zeichen:6} Z | {s.blocks[0].text[:60]!r}"
            )
        return
    for i, a in enumerate(artikel, 1):
        seiten = a.pages
        zeichen = sum(len(b.text) for b in a.blocks)
        print(
            f"    #{i:3} S.{seiten[0] + 1:3}-{seiten[-1] + 1:<3} {zeichen:6} Z "
            f"{len(a.blocks):3} Abs | {a.title[:66]}"
        )
    if args.artikel:
        a = artikel[args.artikel - 1]
        print(f"\n--- Artikel {args.artikel}: {a.title}")
        if a.subtitle:
            print(f"    Unterzeile: {a.subtitle}")
        if a.author:
            print(f"    Autor: {a.author}")
        print()
        for b in a.blocks:
            marke = "" if b.kind == "paragraph" else f"[{b.kind}] "
            print(f"S{b.page_index + 1:<3} {marke}{b.text}\n")


def main() -> int:
    p = argparse.ArgumentParser(description="Satzdatei auswerten")
    p.add_argument("ziel", nargs="+")
    p.add_argument("--artikel", type=int, help="Volltext dieses Artikels zeigen")
    p.add_argument("--stories", action="store_true", help="Stories statt Artikel")
    p.add_argument("--json", help="Bericht als JSON schreiben")
    args = p.parse_args()

    berichte = []
    for roh in args.ziel:
        idml = satzdatei(pathlib.Path(roh))
        if idml is None:
            print(f"!! keine IDML in {roh}")
            continue
        bericht = auswerten(idml)
        zeige(bericht, args)
        berichte.append(
            {
                k: v
                for k, v in bericht.items()
                if k not in ("artikel", "stories")
            }
            | {
                "artikelListe": [
                    {
                        "titel": a.title,
                        "unterzeile": a.subtitle,
                        "autor": a.author,
                        "seiten": a.pages,
                        "zeichen": sum(len(b.text) for b in a.blocks),
                        "absaetze": [b.text for b in a.blocks],
                    }
                    for a in bericht["artikel"]
                ]
            }
        )
    if args.json:
        pathlib.Path(args.json).write_text(
            json.dumps(berichte, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\nBericht: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
