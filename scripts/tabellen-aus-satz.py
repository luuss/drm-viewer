#!/usr/bin/env python3
"""Tabellen einer Satzdatei so ausgeben, wie der Import sie speichern wuerde.

    scripts/tabellen-aus-satz.py <idml> [--seitenversatz 1] [--json datei]

Fuer Hefte, die vor der Tabellenunterstuetzung eingelesen wurden: die Ausgabe
ist der `block` fuer `tabellen:einsetzenInternal` (siehe convex/tabellen.ts).
Ein Neuimport ist dafuer nicht noetig; er wuerde die Freigaben verwerfen.

`--seitenversatz` rechnet die Seite des Satzes in die Leserseite um: liegt
vor dem Innenteil nur der Umschlag (U1), ist er 1.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HIER = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HIER.parent / "extract-service"))

from extractor.idml_extract import extract_idml_blocks, extract_idml_frames  # noqa: E402


def tabellen(idml: pathlib.Path, versatz: int) -> list[dict]:
    data = idml.read_bytes()
    _bilder, texte = extract_idml_frames(data)
    out = []
    for b in extract_idml_blocks(data, text_frames=texte):
        if b.kind != "table" or b.table is None:
            continue
        # Der Import rechnet die Rahmen in die Trimbox der PDF-Seite um; die
        # ist die volle Seite (image_regions.read_trim_boxes), die Lage bleibt.
        out.append(
            {
                "text": b.text,
                "table": b.table.to_payload(),
                "sourcePageIndex": b.page_index + versatz,
                "sourceY": round(max(0.0, min(1.0, b.y0)), 5),
                "sourceStoryId": b.story_id,
                **({"sourceFrameId": b.frame_id} if b.frame_id else {}),
                **({"styleName": b.style_name} if b.style_name else {}),
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("idml", type=pathlib.Path)
    parser.add_argument("--seitenversatz", type=int, default=0)
    parser.add_argument("--json", type=pathlib.Path)
    args = parser.parse_args()
    gefunden = tabellen(args.idml, args.seitenversatz)
    if args.json:
        args.json.write_text(json.dumps(gefunden, ensure_ascii=False, indent=1))
    for t in gefunden:
        print(
            f"Story {t['sourceStoryId']} · Leserseite {t['sourcePageIndex']} "
            f"(0-basiert) · y {t['sourceY']}"
        )
        print("  " + t["text"].replace("\n", "\n  "))
    if not gefunden:
        print("keine Tabellen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
