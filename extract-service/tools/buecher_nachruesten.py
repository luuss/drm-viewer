#!/usr/bin/env python3
"""Buchflaechen fuer schon importierte Hefte nachruesten.

Ein neuer Import legt je Buch einer Bucherseite oder Besprechung eine eigene
Flaeche an (extractor/buecher.py, Worker `_buchflaechen`). Hefte, die vorher
importiert wurden, bekommen sie hiermit, ohne neuen Import — Artikel und
Freigaben bleiben. Nur die Buchflaechen werden ersetzt
(`pageLinks:replaceBooksInternal`), danach loest das Backend sie im Laden auf.

Die Satzdatei liegt lokal vor (dieselbe, die beim Import hochging). Die
Leserseite ist Quellseite + Versatz: vor dem Innenteil stehen U1 und U2.

Aufruf (aus extract-service/):
    .venv/bin/python tools/buecher_nachruesten.py <issueId> <datei.idml>          # Probelauf
    .venv/bin/python tools/buecher_nachruesten.py <issueId> <datei.idml> --echt \\
        --env-file ../_scratch/verlag-direkt.env

Bestand 05.10.2026 (Satzdateien unter _scratch/hefte/):
    md71mgtw38kpw64aj5ss5s44sd8ew0kf  ZUERST! 3/2026
    md74608hdwkkb80tpr407mfz1x8fdcc7  DMZ 170
    md77vdwpsjn3rqwrpxzcwgka158fcrqr  DMZ-Zeitgeschichte 80
    md71crwg2qkqa990e5vmdwwz4d8exmee  Schwerterträger 36 (Greim) — keine Buecher
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from extractor.buecher import buecher_der_seiten  # noqa: E402
from extractor.idml_articles import ohne_unterlagen, rollen_je_story  # noqa: E402
from extractor.idml_extract import (  # noqa: E402
    extract_idml_blocks,
    extract_idml_frames,
    frames_to_blocks,
    frames_to_images,
)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def links_aus_satz(idml_bytes: bytes, versatz: int) -> list[dict]:
    """Die Buchflaechen wie im Worker: Satzrahmen und Bilder, Netzformat = Seite."""
    bildrahmen, textrahmen = extract_idml_frames(idml_bytes)
    roh = extract_idml_blocks(idml_bytes, textrahmen)
    bilder = ohne_unterlagen(bildrahmen, textrahmen, rollen_je_story(roh))
    seiten = sorted({b.page_index for b in roh} | {b.page_number for b in bildrahmen})
    page_map = [(s, s + versatz) for s in seiten]
    blocks = frames_to_blocks(roh, page_map, {})
    images = frames_to_images(bilder, page_map, {})
    return [b.als_link() for b in buecher_der_seiten(blocks, images)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("issue_id")
    ap.add_argument("idml")
    ap.add_argument("--versatz", type=int, default=2, help="Leserseite = Quellseite + Versatz (U1, U2)")
    ap.add_argument("--echt", action="store_true", help="in Convex schreiben")
    ap.add_argument("--env-file", help="fuer `npx convex run` (Deploy-Schluessel)")
    args = ap.parse_args()

    with open(args.idml, "rb") as f:
        links = links_aus_satz(f.read(), args.versatz)
    for l in links:
        print(f"  Seite {l['pageIndex'] + 1:>3}  {l['label']}" + (f"  Art. {l['reference']}" if l.get("reference") else ""))
    print(f"{len(links)} Buecher")
    if not args.echt:
        print("Probelauf. Mit --echt --env-file <datei> schreiben.")
        return 0
    cmd = ["npx", "convex", "run"]
    if args.env_file:
        cmd += ["--env-file", args.env_file]
    cmd += ["pageLinks:replaceBooksInternal", json.dumps({"issueId": args.issue_id, "links": links})]
    return subprocess.call(cmd, cwd=ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
