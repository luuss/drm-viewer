#!/usr/bin/env python3
"""Einen Ausschnitt aus dem Satz eines Hefts als Testvorlage schreiben.

Aufruf:
    .venv/bin/python tools/satz_fixture.py <heftordner> <speicher> <ausgabe.json> <leserseite>...

`<heftordner>/auftrag.json` und `<speicher>` wie bei tools/probelauf.py. Die
Vorlage enthaelt fuer die genannten Leserseiten alle Absaetze (mit Story,
Absatzformat, Absatzgruppe, Rahmen), alle Bildrahmen (mit Datei) und alle
Textrahmen — in Leserkoordinaten, so wie `worker._from_idml` sie an
`satzbilder.bilder_im_satz` gibt. Lange Absaetze werden in der Mitte
gekuerzt: Anfang und Ende (Preis, Grussformel) bleiben, die Laenge auch.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from extractor.idml_articles import ohne_unterlagen, ohne_vorschaubilder, rollen_je_story  # noqa: E402
from extractor.idml_extract import (  # noqa: E402
    extract_idml_blocks,
    extract_idml_frames,
    frames_to_blocks,
    frames_to_images,
    textrahmen_auf_seiten,
)
from extractor.satzbilder import ohne_schriftzuege  # noqa: E402

KUERZEN_AB = 700


def _kurz(text: str) -> str:
    if len(text) <= KUERZEN_AB:
        return text
    rest = len(text) - 600
    return text[:300] + "x" * rest + text[-300:]


def _r(werte) -> list[float]:
    return [round(v, 4) for v in werte]


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__)
        return 2
    heftordner, speicher, ausgabe = sys.argv[1:4]
    seiten = {int(s) for s in sys.argv[4:]}
    with open(os.path.join(heftordner, "auftrag.json"), encoding="utf-8") as f:
        auftrag = json.load(f)
    idml = next(s for s in auftrag["sources"] if s["kind"] == "idml")
    with open(os.path.join(speicher, idml["assetKey"]), "rb") as f:
        data = f.read()
    page_map = sorted(
        (p["sourcePageIndex"], p["index"]) for p in auftrag["pages"] if p.get("role") == "content"
    )
    bildrahmen, textrahmen = extract_idml_frames(data)
    roh = extract_idml_blocks(data, textrahmen)
    gefiltert = ohne_unterlagen(bildrahmen, textrahmen, rollen_je_story(roh))
    gefiltert = ohne_schriftzuege(ohne_vorschaubilder(gefiltert, textrahmen, roh))
    blocks = frames_to_blocks(roh, page_map, {})
    images = frames_to_images(gefiltert, page_map, {})
    rahmen = textrahmen_auf_seiten(textrahmen, page_map, {})
    out = {
        "quelle": idml["filename"],
        "seiten": sorted(seiten),
        "blocks": [
            {
                "page": b.page_index,
                "text": _kurz(b.text),
                "style": b.style_name,
                "story": b.story_id,
                "frame": b.frame_id,
                "gruppe": b.absatzgruppe,
                "kind": b.kind,
                "box": _r((b.x0, b.y0, b.x1, b.y1)),
                "frameBox": _r(b.frame_box) if b.frame_box else None,
            }
            for b in blocks
            if b.page_index in seiten
        ],
        "images": [
            {"page": i.page_index, "box": _r((i.x0, i.y0, i.x1, i.y1)), "link": i.link}
            for i in images
            if i.page_index in seiten
        ],
        "frames": [
            {"page": f.page_number, "box": _r((f.x0, f.y0, f.x1, f.y1)), "story": f.story_id, "id": f.self_id}
            for f in rahmen
            if f.page_number in seiten
        ],
    }
    with open(ausgabe, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(ausgabe, len(out["blocks"]), len(out["images"]), len(out["frames"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
