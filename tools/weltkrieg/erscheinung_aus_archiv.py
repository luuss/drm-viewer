"""Erscheinungsdatum der Weltkrieg-Hefte aus dem Heftarchiv (05.11.2026).

Aufruf aus drm-viewer/:
    python3 -I tools/weltkrieg/erscheinung_aus_archiv.py <liste.json> <aus.json>

<liste.json> ist die Ordnerliste des Archivs (Admin -> "Ordnerstruktur
einlesen", liegt in emag-media/struktur/), je Datei [Pfad, Groesse, Datum ms].
Den Bestand fragt es ueber tools/weltkrieg/wkrun.sh ab. <aus.json> bekommt die
Eintraege fuer `devtools:erscheinungSetzenInternal`.

Je Heft gilt das frueheste Dateidatum aller Innenteil-PDFs im Archiv, auch der
Originalausgabe im Reihenordner, wenn der Import die E-Book-Fassung nahm.
Zuordnung Datei -> (Reihe, Nummer) wie tools/weltkrieg/fehlende_hefte.py.

Ein Datum gilt nur, wenn es zur Nummernfolge der Reihe passt: nicht spaeter als
das eines hoeheren Hefts derselben Reihe (mit SPIELRAUM). Fruehe Hefte, die nur
als neu exportierte E-Book-Fassung im Archiv liegen (Originalband 2-14 mit
Datum 2026), bleiben ohne Datum; erfunden wird keins.
"""
import collections
import datetime
import json
import re
import subprocess
import sys
import unicodedata

sys.path.insert(0, "tools/weltkrieg")
from fehlende_hefte import ID, reihe_und_nummer  # noqa: E402

SPIELRAUM_MS = 45 * 86400 * 1000
KENNUNG = re.compile(r"^\s*(\d+)\s*([a-zäöü]{0,10})", re.I)
KENNUNG_VORN = re.compile(r"^\s*([a-z]{1,3})(\d+)\b", re.I)


def kennung(name: str) -> str | None:
    """Wie heftKennung in web/src/admin/heftarchiv.ts."""
    n = unicodedata.normalize("NFC", name)
    m = KENNUNG_VORN.match(n)
    if m:
        return (m.group(1) + m.group(2)).lower()
    m = KENNUNG.match(n)
    if not m:
        return None
    return (re.sub(r"^0+(?=\d)", "", m.group(1)) + m.group(2)).lower()


def innenteil_daten(liste: dict) -> dict[tuple[str, str], list[tuple[int, str]]]:
    daten: dict[tuple[str, str], list[tuple[int, str]]] = collections.defaultdict(list)
    for pfad, _groesse, mtime in liste["dateien"]:
        p = unicodedata.normalize("NFC", pfad)
        teile = p.split("/")
        name = teile[-1]
        eltern = teile[-2] if len(teile) > 1 else ""
        if not name.lower().endswith(".pdf"):
            continue
        innen = re.search("innenteil", name, re.I) or (
            re.search("innenteil", eltern, re.I) and not re.search("umschlag", name, re.I)
        )
        if not innen:
            continue
        k = kennung(name) or kennung(eltern)
        if not k:
            continue
        reihe, nummer = reihe_und_nummer(k, p)
        if reihe:
            daten[(reihe, nummer)].append((int(mtime), p))
    return daten


def main() -> int:
    liste = json.load(open(sys.argv[1]))
    out = subprocess.run(
        ["tools/weltkrieg/wkrun.sh", "--identity", ID, "issues:overviewForEditors", "{}"],
        capture_output=True, text=True,
    ).stdout
    bestand = json.loads(out)
    daten = innenteil_daten(liste)

    je_reihe = collections.defaultdict(list)
    ohne_datei = []
    for i in bestand:
        d = sorted(daten.get((i["publicationName"], i["issueNumber"]), []))
        if not d:
            ohne_datei.append(i)
            continue
        nr = int(i["issueNumber"]) if (i["issueNumber"] or "").isdigit() else None
        je_reihe[i["publicationName"]].append((nr, d[0][0], i))

    eintraege, verworfen = [], []
    tag = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).strftime("%Y-%m-%d")
    for reihe, hefte in sorted(je_reihe.items()):
        hefte.sort(key=lambda h: -(h[0] or 0))
        grenze = None
        for nr, datum, i in hefte:
            if grenze is not None and datum > grenze + SPIELRAUM_MS:
                verworfen.append(f"{reihe} {nr}: {tag(datum)} (hoeheres Heft schon {tag(grenze)})")
                continue
            eintraege.append({"issueId": i["_id"], "publicationDate": datum})
            grenze = datum if grenze is None else min(grenze, datum)

    json.dump(eintraege, open(sys.argv[2], "w"))
    print(f"{len(bestand)} Hefte: {len(eintraege)} mit Datum, {len(verworfen)} verworfen, "
          f"{len(ohne_datei)} ohne Innenteil-PDF im Archiv")
    for v in verworfen:
        print("  verworfen:", v)
    for i in ohne_datei:
        print("  ohne Datei:", i["publicationName"], i["issueNumber"], i["title"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
