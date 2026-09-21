#!/usr/bin/env python3
"""Heft per Kommandozeile anlegen.

Laedt Innenteil, Umschlag und Satzdateien in die Convex-Ablage, legt Titel,
Ausgabe, Quellen und Leserreihenfolge an, stellt den Importauftrag ein und
wartet, bis der Import-Worker fertig ist. Danach steht die Ausgabe in der
Redaktion zur Pruefung; veroeffentlicht wird sie dort.

Zugang: die Convex-Kommandozeile entscheidet ueber das Ziel. Fuer Produktion
CONVEX_DEPLOY_KEY setzen (Umgebung oder .env.local); ohne Key gilt das in
.env.local verknuepfte Entwicklungs-Deployment.

Beispiel DMZ 170:

    scripts/heft-anlegen.py \\
      --publikation "Deutsche Militärzeitschrift" --kennung dmz \\
      --titel "DMZ 170" --nummer 170 --preis 9,80 \\
      --innen "hefte test/dmz 170 innenteil.pdf" \\
      --umschlag "hefte test/umschlag dmz 170.pdf" --umschlag-layout spreads \\
      --archiv "hefte test/dmz 170.indd" --archiv "hefte test/umschlag dmz 170.indd"

Mit --freigeben werden nach dem Import alle Artikel freigegeben und die
Ausgabe veroeffentlicht, ohne redaktionelle Pruefung. Umschlaege mit Klappe
zerlegt vorher scripts/umschlag-zerlegen.py in vier Einzelseiten.

Beispiel ZUERST! (Umschlag als vier Einzelseiten in Bogenreihenfolge):

    scripts/heft-anlegen.py --publikation "ZUERST!" --kennung zuerst \\
      --titel "ZUERST! 3/2026" --nummer 3/2026 --preis 9,99 \\
      --innen "hefte test/zuerst 3-2026 innenteil.pdf" \\
      --umschlag "hefte test/umschlag zuerst 3-2026.pdf" --umschlag-layout sheets
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def convex_run(function: str, args: dict | None = None) -> object:
    """`npx convex run` aufrufen und das Ergebnis als JSON lesen."""
    command = ["npx", "--no-install", "convex", "run", function]
    if args is not None:
        command.append(json.dumps(args, ensure_ascii=False))
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(f"convex run {function} ist fehlgeschlagen")
    # Die Kommandozeile gibt den Rueckgabewert als JSON aus, Objekte und
    # Listen mehrzeilig eingerueckt. Alles davor sind Meldungen.
    lines = result.stdout.splitlines()
    for index, line in enumerate(lines):
        if line[:1] in "{[\"0123456789-tfn":
            return json.loads("\n".join(lines[index:]))
    return None


def page_count(path: str) -> int:
    if shutil.which("pdfinfo"):
        out = subprocess.run(["pdfinfo", path], capture_output=True, text=True, check=True).stdout
        for line in out.splitlines():
            if line.startswith("Pages:"):
                return int(line.split()[1])
    venv_python = os.path.join(ROOT, "extract-service", ".venv", "bin", "python")
    python = venv_python if os.path.exists(venv_python) else sys.executable
    out = subprocess.run(
        [python, "-c", "import sys, pypdfium2; print(len(pypdfium2.PdfDocument(sys.argv[1])))", path],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise SystemExit(
            f"Seitenzahl von {path} nicht bestimmbar: pdfinfo oder pypdfium2 fehlt"
        )
    return int(out.stdout.strip())


def upload(path: str, content_type: str) -> str:
    """Datei in die Convex-Ablage laden, liefert die Storage-ID."""
    url = convex_run("assets:generateUploadUrlInternal", {})
    if not isinstance(url, str):
        raise SystemExit("Keine Upload-Adresse erhalten")
    size = os.path.getsize(path)
    print(f"  lade {os.path.basename(path)} ({size / 1024 / 1024:.0f} MB)", flush=True)
    result = subprocess.run(
        [
            "curl", "--silent", "--show-error", "--fail", "-X", "POST",
            "-H", f"Content-Type: {content_type}",
            "--data-binary", f"@{path}",
            url,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"Upload von {path} ist fehlgeschlagen")
    return json.loads(result.stdout)["storageId"]


def euro_cents(text: str) -> int:
    return round(float(text.replace(",", ".")) * 100)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Heft anlegen und Import starten",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--publikation", required=True, help='Name des Titels, z.B. "ZUERST!"')
    parser.add_argument("--kennung", help="Kennung des Titels (waehlt das Heftprofil), z.B. dmz")
    parser.add_argument("--titel", required=True, help='Titel der Ausgabe, z.B. "DMZ 170"')
    parser.add_argument("--nummer", help="Heftnummer")
    parser.add_argument("--beschreibung", help="Untertitel oder Thema der Ausgabe")
    parser.add_argument("--datum", help="Erscheinungsdatum JJJJ-MM-TT")
    parser.add_argument("--preis", required=True, help="Einzelpreis in Euro, z.B. 9,80")
    parser.add_argument("--innen", required=True, help="Innenteil-PDF")
    parser.add_argument("--umschlag", help="Umschlag-PDF")
    parser.add_argument(
        "--umschlag-layout",
        choices=["sheets", "spreads"],
        help="sheets: vier Einzelseiten (U4, U1, U2, U3); spreads: zwei Doppelseiten (U4|U1, U2|U3)",
    )
    parser.add_argument("--archiv", action="append", default=[], help=".indd-Datei, mehrfach moeglich")
    parser.add_argument("--erste-seite", type=int, default=3, help="gedruckte Seitenzahl der ersten Innenseite")
    parser.add_argument("--nicht-warten", action="store_true", help="nicht auf den Worker warten")
    parser.add_argument(
        "--freigeben",
        action="store_true",
        help="nach dem Import alle Artikel freigeben und die Ausgabe veroeffentlichen",
    )
    args = parser.parse_args()
    if args.freigeben and args.nicht_warten:
        raise SystemExit("--freigeben braucht das Warten auf den Worker")

    for path in [args.innen, args.umschlag, *args.archiv]:
        if path and not os.path.exists(path):
            raise SystemExit(f"Datei fehlt: {path}")

    print("Dateien werden hochgeladen …")
    inner_id = upload(args.innen, "application/pdf")
    seed: dict = {
        "publicationName": args.publikation,
        "title": args.titel,
        "priceAmountCents": euro_cents(args.preis),
        "innerStorageId": inner_id,
        "innerFilename": os.path.basename(args.innen),
        "innerPageCount": page_count(args.innen),
        "printedStart": args.erste_seite,
    }
    if args.kennung:
        seed["publicationSlug"] = args.kennung
    if args.nummer:
        seed["issueNumber"] = args.nummer
    if args.beschreibung:
        seed["description"] = args.beschreibung
    if args.datum:
        seed["publicationDate"] = int(
            datetime.datetime.strptime(args.datum, "%Y-%m-%d")
            .replace(tzinfo=datetime.timezone.utc)
            .timestamp()
            * 1000
        )
    if args.umschlag:
        seed["coverStorageId"] = upload(args.umschlag, "application/pdf")
        seed["coverFilename"] = os.path.basename(args.umschlag)
        seed["coverPageCount"] = page_count(args.umschlag)
        if args.umschlag_layout:
            seed["coverLayout"] = args.umschlag_layout
    if args.archiv:
        seed["archives"] = [
            {"storageId": upload(path, "application/octet-stream"), "filename": os.path.basename(path)}
            for path in args.archiv
        ]

    print("Ausgabe wird angelegt …")
    result = convex_run("devtools:seedIssueFromAssets", seed)
    if not isinstance(result, dict):
        raise SystemExit(f"Unerwartete Antwort: {result!r}")
    print(
        f"Ausgabe {result['issueId']} mit {result['pages']} Seiten angelegt, "
        f"Titel {result['publicationSlug']}, Auftrag {result['jobId']}"
    )
    if args.nicht_warten:
        return 0

    print("Warte auf den Import-Worker …")
    last = None
    for _ in range(240):
        status = convex_run("devtools:jobStatusInternal", {"jobId": result["jobId"]})
        if not isinstance(status, dict):
            raise SystemExit("Auftrag nicht mehr auffindbar")
        line = f"  {status['status']} {status.get('progress') or 0:>3}% {status.get('message') or ''}"
        if line != last:
            print(line, flush=True)
            last = line
        if status["status"] in ("review", "done"):
            print(
                f"Fertig: {status.get('articleCount')} Artikelentwuerfe auf "
                f"{status.get('pageCount')} Seiten. Ausgabe /issue/{status.get('issueSlug')} "
                "steht in der Redaktion zur Pruefung."
            )
            if args.freigeben:
                released = convex_run("devtools:releaseIssueInternal", {"issueId": result["issueId"]})
                if not isinstance(released, dict):
                    raise SystemExit(f"Freigabe fehlgeschlagen: {released!r}")
                print(
                    f"Veroeffentlicht: {released['approved']} von {released['articles']} "
                    f"Artikeln freigegeben, Ausgabe /issue/{released.get('slug')} ist im Kiosk."
                )
            return 0
        if status["status"] == "error":
            raise SystemExit(f"Import fehlgeschlagen: {status.get('message')}")
        time.sleep(15)
    raise SystemExit("Der Worker hat sich innerhalb einer Stunde nicht gemeldet")


if __name__ == "__main__":
    sys.exit(main())
