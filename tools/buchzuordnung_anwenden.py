#!/usr/bin/env python3
"""Plan aus tools/buchzuordnung_sim.ts live eintragen oder zuruecknehmen.

    python3 tools/buchzuordnung_anwenden.py <plan.json>            # Probelauf
    python3 tools/buchzuordnung_anwenden.py <plan.json> --echt     # neu eintragen
    python3 tools/buchzuordnung_anwenden.py <plan.json> --zurueck  # altes Ziel

Schreibt nur `url` einzelner Buchflaechen (`pageLinks:setFieldsInternal`).
"Zurueck" setzt das Ziel, das der Leser vorher bekam (bei offenen Flaechen
die Suchseite, die `zielAdresse` sonst ausgerechnet hat) — fuer den Leser
derselbe Stand wie vorher.
"""
import json
import subprocess
import sys

ENV = "_scratch/verlag-direkt.env"


def main() -> None:
    plan = json.load(open(sys.argv[1], encoding="utf-8"))
    echt = "--echt" in sys.argv
    zurueck = "--zurueck" in sys.argv
    for p in plan:
        url = p["vorher"] if zurueck else p["neu"]
        print(f"{p['label'][:60]:60} -> {url}")
        if not (echt or zurueck) or not url:
            continue
        subprocess.run(
            ["npx", "convex", "run", "--env-file", ENV, "pageLinks:setFieldsInternal",
             json.dumps({"id": p["id"], "url": url})],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    print(f"{len(plan)} Flaechen", "geschrieben" if (echt or zurueck) else "(Probelauf)")


if __name__ == "__main__":
    main()
