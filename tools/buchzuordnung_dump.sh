#!/bin/bash
# Stand aller Buchzuordnungen lesen (nur Abfragen, schreibt nichts).
#
#   bash tools/buchzuordnung_dump.sh <issues.json> <zielordner> <userId eines Redakteurs>
#
# issues.json: Ausgabe von `issues:listForEditors` (gleiche Identitaet).
# Je Heft: Buchflaechen (pageLinks), Artikelzuordnungen (articleProducts),
# Artikel mit Absaetzen und Flaechen, und was der Leser bekommt.
set -u
ISSUES="$1"
D="$2"
ID="{\"subject\":\"$3|x\",\"issuer\":\"x\"}"
ENV="${ENV_FILE:-_scratch/verlag-direkt.env}"
mkdir -p "$D"
for i in $(python3 -c "import json,sys;[print(x['_id']) for x in json.load(open(sys.argv[1]))]" "$ISSUES"); do
  for f in pageLinks:listForEditors articleProducts:listForEditors articles:listForEditors pageLinks:forReader articleProducts:forReader; do
    n=$(echo "$f" | tr ':' '_')
    npx convex run --env-file "$ENV" --identity "$ID" "$f" "{\"issueId\":\"$i\"}" > "$D/$i.$n.json" 2>/dev/null || echo "FAIL $i $f"
  done
done
