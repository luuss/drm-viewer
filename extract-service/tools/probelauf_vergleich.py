#!/usr/bin/env python3
"""Zwei Probelaeufe (tools/probelauf.py) Heft fuer Heft vergleichen.

Aufruf:
    .venv/bin/python tools/probelauf_vergleich.py <lauf-alt> <lauf-neu> [--details]

Ein Lauf ist ein Ordner mit je einem Unterordner pro Heft (darin ergebnis.json).
Ausgegeben werden je Heft die Zahl der Artikel, Bilder, Bildunterschriften und
Verzeichniseintraege, die Zahl bekannter Fehlermuster im Text und — mit
--details — welche Titel, Unterschriften und Verzeichnisziele sich geaendert
haben. Gedacht als Probe vor dem Ausrollen: was besser werden sollte, muss
sinken; was sich sonst aendert, muss erklaerbar sein.
"""

from __future__ import annotations

import json
import os
import re
import sys

MUSTER = {
    "strich_vor_wort": re.compile(r"(?<=[\w,“”\"'.] )-(?=[A-ZÄÖÜ])"),
    "doppelstrich": re.compile(r"\w--\w"),
    "euro_als_t": re.compile(r"\bt (?=\d{1,4}(?:[.,]\d{2}|,–|,-))"),
    "symbolzeichen": re.compile(r"[-]"),
    "akzent_abgesetzt": re.compile(r"[^\W\d_][˘˜¨ˇ˚˛˝ˆ][^\W\d_]"),
    "strich_leer_im_titel": re.compile(r"[^\W\d_]- (?!und |oder |bis |sowie )"),
}


def laden(ordner: str) -> dict[str, dict]:
    out = {}
    for heft in sorted(os.listdir(ordner)):
        pfad = os.path.join(ordner, heft, "ergebnis.json")
        if os.path.exists(pfad):
            with open(pfad, encoding="utf-8") as f:
                out[heft] = json.load(f)
    return out


def kennzahlen(erg: dict) -> dict:
    artikel = erg["artikel"]
    bilder = [b for a in artikel for b in a["bilder"]]
    texte = [b["text"] for a in artikel for b in a["bloecke"] if b.get("text")]
    titel = [a["titel"] or "" for a in artikel]
    z = {
        "artikel": len(artikel),
        "bilder": len(bilder),
        "mit_unterschrift": sum(1 for b in bilder if b["unterschrift"]),
        "mit_untertitel": sum(1 for a in artikel if a["untertitel"]),
        "verzeichnis": len(erg["verzeichnis"]),
        "verzeichnis_ohne_artikel": sum(
            1 for t in erg["verzeichnis"] if t.get("articleOrder") is None
        ),
    }
    for name, muster in MUSTER.items():
        quelle = titel if name == "strich_leer_im_titel" else texte + titel
        z[name] = sum(len(muster.findall(t)) for t in quelle)
    return z


def _artikel_schluessel(a: dict) -> tuple:
    return (a["seiten"][0], (a["bloecke"][0]["text"][:40] if a["bloecke"] else ""))


def details(alt: dict, neu: dict) -> list[str]:
    zeilen = []
    a_map = {_artikel_schluessel(a): a for a in alt["artikel"]}
    n_map = {_artikel_schluessel(a): a for a in neu["artikel"]}
    for k in sorted(set(a_map) | set(n_map), key=lambda k: (k[0], k[1])):
        a, n = a_map.get(k), n_map.get(k)
        if a is None:
            zeilen.append(f"  + S.{k[0]} neu: {n['titel']!r}")
            continue
        if n is None:
            zeilen.append(f"  - S.{k[0]} weg: {a['titel']!r}")
            continue
        for feld in ("titel", "untertitel", "autor"):
            if a[feld] != n[feld]:
                zeilen.append(f"  ~ S.{k[0]} {feld}: {a[feld]!r} -> {n[feld]!r}")
        ab = [(os.path.basename(b["datei"] or ""), b["unterschrift"]) for b in a["bilder"]]
        nb = [(os.path.basename(b["datei"] or ""), b["unterschrift"]) for b in n["bilder"]]
        if ab != nb:
            zeilen.append(
                f"  ~ S.{k[0]} {n['titel']!r}: Bilder {len(ab)} -> {len(nb)}, "
                f"Unterschriften {sum(1 for _, u in ab if u)} -> {sum(1 for _, u in nb if u)}"
            )
    av = [(t.get("label"), t.get("pageIndex"), t.get("articleOrder")) for t in alt["verzeichnis"]]
    nv = [(t.get("label"), t.get("pageIndex"), t.get("articleOrder")) for t in neu["verzeichnis"]]
    if av != nv:
        for x in av:
            if x not in nv:
                zeilen.append(f"  - Verzeichnis {x}")
        for x in nv:
            if x not in av:
                zeilen.append(f"  + Verzeichnis {x}")
    return zeilen


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 2
    mit_details = "--details" in sys.argv
    alt, neu = laden(args[0]), laden(args[1])
    summe_a: dict[str, int] = {}
    summe_n: dict[str, int] = {}
    for heft in sorted(set(alt) | set(neu)):
        if heft not in alt or heft not in neu:
            print(f"{heft}: nur in {'alt' if heft in alt else 'neu'}")
            continue
        za, zn = kennzahlen(alt[heft]), kennzahlen(neu[heft])
        for k in za:
            summe_a[k] = summe_a.get(k, 0) + za[k]
            summe_n[k] = summe_n.get(k, 0) + zn[k]
        diff = {k: f"{za[k]}->{zn[k]}" for k in za if za[k] != zn[k]}
        print(f"{heft}: {diff or 'unveraendert'}")
        if mit_details:
            for z in details(alt[heft], neu[heft]):
                print(z)
    print("Summe:", {k: f"{summe_a[k]}->{summe_n[k]}" for k in summe_a})
    return 0


if __name__ == "__main__":
    sys.exit(main())
