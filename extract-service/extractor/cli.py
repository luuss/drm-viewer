"""Kommandozeile zum Pruefen der Extraktion an echten Heften."""

from __future__ import annotations

import argparse
import json
import sys

from .idml_extract import extract_idml
from .pdf_extract import extract_pdf


def main() -> int:
    ap = argparse.ArgumentParser(description="Heft in Artikel zerlegen")
    ap.add_argument("file", help="PDF oder IDML")
    ap.add_argument("--out", help="JSON-Ausgabedatei")
    ap.add_argument("--no-llm", action="store_true", help="KI-Gruppierung aus")
    ap.add_argument("--full", action="store_true", help="Volltext mit ausgeben")
    args = ap.parse_args()

    if args.file.lower().endswith(".idml"):
        articles = extract_idml(args.file)
    else:
        articles = extract_pdf(args.file, use_llm=not args.no_llm)

    for a in articles:
        print(
            f'#{a["order"]:>3} S.{a["pageStart"]:>3}-{a["pageEnd"]:<3} '
            f'{len(a["text"]):>6} Z. | {a["title"][:70]}'
        )
    print(f"\n{len(articles)} Artikel, {sum(len(a['text']) for a in articles)} Zeichen")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(articles, fh, ensure_ascii=False, indent=1)
        print(f"geschrieben: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
