"""Soll/Ist: welche Hefte des Archivs fehlen im Weltkrieg-Leser (03.11.2026).

Aufruf aus drm-viewer/:
    python3 -I tools/weltkrieg/fehlende_hefte.py
Braucht die Archiv-Hefte (`_scratch/wk-struktur/archiv-hefte.json`, erzeugt mit
`ARCHIV_LISTE=… ARCHIV_AUS=… npx vitest run web/src/admin/heftarchiv.liste.test.ts`
aus der Ordnerliste) und fragt den Bestand ueber `tools/weltkrieg/wkrun.sh` ab.
Schreibt `docs/weltkrieg-fehlende-hefte.md`.

Zuordnung Archiv -> Leser nur fuer diesen Bericht: Reihe aus dem Buchstaben der
Kennung ("159d" -> Doppelband), sonst aus dem Reihenordner. Der Import selbst
nimmt die Reihe von der Titelseite.
"""
import json
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict

ID = '{"subject":"q973ryepe70ds5b3bczf34ewsn8hhhf1|x","issuer":"x","tokenIdentifier":"x"}'
BUCHSTABE = {
    "d": "Weltkrieg Doppelband",
    "n": "Weltkrieg Originalband",
    "g": "Weltkrieg Großband",
    "f": "Weltkrieg Flieger",
    "m": "Weltkrieg Marine",
    "mag": "Weltkrieg Magazin",
    "fk": "Freikorps",
    "fl": "Legion",
    "legion": "Legion",
    "sol": "Weltkrieg Soldaten",
    "soldaten": "Weltkrieg Soldaten",
    "b": "Blitzkrieg",
}
ORDNER = {
    "doppelbände": "Weltkrieg Doppelband",
    "fliegerhefte": "Weltkrieg Flieger",
    "freikorps": "Freikorps",
    "fremdenlegion": "Legion",
    "großbände": "Weltkrieg Großband",
    "magazinhefte": "Weltkrieg Magazin",
    "marinehefte": "Weltkrieg Marine",
    "normalhefte": "Weltkrieg Originalband",
    "soldaten-reihe": "Weltkrieg Soldaten",
}


def reihe_und_nummer(kennung: str, pfad: str):
    m = re.fullmatch(r"([a-z]{1,3})(\d+)", kennung)
    if m:  # "b1"
        return BUCHSTABE.get(m.group(1)), m.group(2)
    m = re.fullmatch(r"(\d+)([a-zäöü]*)", kennung)
    if not m:
        return None, None
    nummer, buchst = m.group(1), m.group(2)
    reihe = BUCHSTABE.get(buchst)
    if not reihe:
        teil = unicodedata.normalize("NFC", pfad.split("/")[1]).strip().lower()
        reihe = ORDNER.get(teil)
    return reihe, nummer


def main() -> int:
    archiv = json.load(open("_scratch/wk-struktur/archiv-hefte.json"))
    out = subprocess.run(
        ["tools/weltkrieg/wkrun.sh", "--identity", ID, "issues:overviewForEditors", "{}"],
        capture_output=True, text=True,
    ).stdout
    bestand = json.loads(out)
    im_leser = {(i["publicationName"], i["issueNumber"]): i for i in bestand}

    fehlt = defaultdict(list)
    gefunden = set()
    unklar = []
    for h in archiv["hefte"]:
        reihe, nummer = reihe_und_nummer(h["kennung"], h["pfad"])
        if not reihe:
            unklar.append(h)
            continue
        if (reihe, nummer) in im_leser:
            gefunden.add((reihe, nummer))
        else:
            fehlt[reihe].append((int(nummer), h))

    zeilen = [
        "# Weltkrieg: fehlende und unvollständige Hefte",
        "",
        "Erzeugt mit `tools/weltkrieg/fehlende_hefte.py` (Soll aus der Ordnerliste des",
        "Archivs, Ist aus dem Leser). Neu erzeugen nach jedem Import.",
        "",
        f"* Archiv: **{len(archiv['hefte'])} Hefte mit PDF**, {len(archiv['nurIndd'])} nur als INDD",
        f"* Im Leser: **{len(bestand)} Hefte**, davon {len(gefunden)} dem Archiv zugeordnet",
        f"* Fehlen: **{sum(len(v) for v in fehlt.values())}**",
        "",
        "## Fehlen im Leser (PDF liegt im Archiv)",
        "",
    ]
    for reihe in sorted(fehlt):
        zeilen.append(f"### {reihe} ({len(fehlt[reihe])})")
        zeilen.append("")
        for nummer, h in sorted(fehlt[reihe], key=lambda x: x[0]):
            art = "IDML+PDF" if h["mitIdml"] else "PDF"
            zeilen.append(f"* {nummer} · {art} · `{h['pfad']}`")
        zeilen.append("")
    probleme = [
        i for i in bestand
        if not i.get("coverUrl") or not i.get("pageCount") or not i.get("articleCount")
    ]
    zeilen += ["## Im Leser, aber unvollständig", ""]
    if not probleme:
        zeilen.append("Keine.")
    for i in sorted(probleme, key=lambda i: (i["publicationName"] or "", int(re.match(r"\d*", i["issueNumber"] or "0").group() or 0))):
        was = []
        if not i.get("coverUrl"):
            was.append("ohne Cover")
        if not i.get("pageCount"):
            was.append("ohne Seiten")
        if not i.get("articleCount"):
            was.append("ohne Text")
        zeilen.append(f"* {i['publicationName']} {i['issueNumber']} „{i['title']}“: {', '.join(was)}")
    zeilen += ["", "## Nur als INDD im Archiv (Import kann sie nicht lesen)", ""]
    for h in sorted(archiv["nurIndd"], key=lambda h: h["pfad"]):
        zeilen.append(f"* {h['kennung']} · `{h['pfad']}`")
    if unklar:
        zeilen += ["", "## Reihe nicht zuzuordnen (von Hand prüfen)", ""]
        zeilen += [f"* {h['kennung']} · `{h['pfad']}`" for h in unklar]
    open("docs/weltkrieg-fehlende-hefte.md", "w").write("\n".join(zeilen) + "\n")
    print(f"Archiv {len(archiv['hefte'])}, Leser {len(bestand)}, zugeordnet {len(gefunden)}, "
          f"fehlen {sum(len(v) for v in fehlt.values())}, unvollstaendig {len(probleme)}, unklar {len(unklar)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
