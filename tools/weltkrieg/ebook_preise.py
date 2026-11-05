"""E-Book-Preise der Weltkrieg-Reihen aus dem Laden (05.11.2026).

Aufruf aus drm-viewer/:
    python3 -I tools/weltkrieg/ebook_preise.py <aus.json>

Anweisung: jede Reihe hat im Laden einen festen E-Book-Preis; der gilt im
Leser fuer jedes Heft der Reihe. Reihenpreis = Preis der Variante "E-Book"
des neuesten E-Books der Reihe in der Kategorie E-Books von
weltkrieg-online.de (WooCommerce Store API, oeffentlich). Aeltere E-Books mit
anderem Preis (Doppelband 3,99, Grossband 2,99) und solche mit 0 € zaehlen
nicht. Das Magazin hat im Laden kein E-Book; es kostet als E-Book dasselbe
wie der Grossband (Anweisung 05.11.2026, `WIE_REIHE`).

Schreibt die Eintraege fuer `devtools:preiseSetzenInternal` und zeigt die
Reihenpreise. Den Bestand fragt es ueber tools/weltkrieg/wkrun.sh ab.
"""
import html
import json
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, "tools/weltkrieg")
from fehlende_hefte import ID  # noqa: E402

LADEN = "https://weltkrieg-online.de/wp-json/wc/store/v1"
KATEGORIE_EBOOKS = 89
# Name im Laden ("Originalband – Heft 330") -> Zeitschrift im Leser.
REIHE = {
    "Originalband": "Weltkrieg Originalband",
    "Doppelband": "Weltkrieg Doppelband",
    "Großband": "Weltkrieg Großband",
    "Flieger": "Weltkrieg Flieger",
    "Marine": "Weltkrieg Marine",
    "Soldaten": "Weltkrieg Soldaten",
    "Magazin": "Weltkrieg Magazin",
    "Legion": "Legion",
    "Blitzkrieg": "Blitzkrieg",
    "Freikorps": "Freikorps",
}


# Reihen ohne E-Book im Laden, die den Preis einer anderen Reihe bekommen.
WIE_REIHE = {"Weltkrieg Magazin": "Weltkrieg Großband"}


def holen(pfad: str):
    req = urllib.request.Request(LADEN + pfad, headers={"User-Agent": "weltkrieg-digital-preise"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def ebook_preis(p: dict) -> int | None:
    """Preis der Variante E-Book in Cent (einfaches Produkt: sein Preis)."""
    if p["type"] != "variable":
        return int(p["prices"]["price"])
    for v in p.get("variations", []):
        if any(a["value"].lower().replace("-", "") == "ebook" for a in v["attributes"]):
            return int(holen(f"/products/{v['id']}")["prices"]["price"])
    return None


def main() -> int:
    produkte = []
    seite = 1
    while True:
        teil = holen(f"/products?category={KATEGORIE_EBOOKS}&per_page=100&page={seite}")
        produkte += teil
        if len(teil) < 100:
            break
        seite += 1
    neueste: dict[str, tuple[int, int, str]] = {}
    for p in produkte:
        name = html.unescape(p["name"])
        m = re.match(r"(.+?)\s+[–-]\s+Heft\s+(\d+)", name)
        if not m or m.group(1) not in REIHE:
            print("  unbekannt:", name)
            continue
        preis = ebook_preis(p)
        if not preis:
            print(f"  ohne Preis im Laden: {name}")
            continue
        reihe, nr = REIHE[m.group(1)], int(m.group(2))
        if reihe not in neueste or nr > neueste[reihe][0]:
            neueste[reihe] = (nr, preis, name)

    for reihe, vorbild in WIE_REIHE.items():
        if reihe not in neueste and vorbild in neueste:
            nr, preis, name = neueste[vorbild]
            neueste[reihe] = (nr, preis, f"wie {vorbild}")
    out = subprocess.run(
        ["tools/weltkrieg/wkrun.sh", "--identity", ID, "issues:overviewForEditors", "{}"],
        capture_output=True, text=True,
    ).stdout
    bestand = json.loads(out)
    eintraege, ohne = [], {}
    for i in bestand:
        r = neueste.get(i["publicationName"])
        if r:
            eintraege.append({"issueId": i["_id"], "priceAmountCents": r[1]})
        else:
            ohne[i["publicationName"]] = ohne.get(i["publicationName"], 0) + 1
    json.dump(eintraege, open(sys.argv[1], "w"))
    for reihe, (nr, preis, name) in sorted(neueste.items()):
        anzahl = sum(1 for i in bestand if i["publicationName"] == reihe)
        print(f"{reihe:24s} {preis / 100:5.2f} €  ({anzahl} Hefte; nach {name})")
    for reihe, n in ohne.items():
        print(f"{reihe:24s}  kein E-Book im Laden ({n} Hefte ohne Preis)")
    print(f"{len(eintraege)} Eintraege")
    return 0


if __name__ == "__main__":
    sys.exit(main())
