#!/bin/sh
# Titel und Reihe aller Hefte von digital.weltkrieg-online.de pruefen, mit den
# Regeln des Imports (web/src/admin/heftTitel.ts, umschlagTitel.ts). Nach
# jedem Import laufen lassen (docs/weltkrieg-digital.md, "Prüfen nach jedem
# Import").
#
#   tools/weltkrieg/titel_pruefen.sh [--archiv liste.json] [--anwenden]
#
# Ohne --anwenden nur der Bericht. Mit --anwenden werden die sicheren
# Berichtigungen (beide Quellen einig, oder Heftnummer) und die Vermerke
# "Titel pruefen" geschrieben, in Paketen zu 15 Heften. Ein Titel mit Vermerk
# bleibt, wie er ist: die Redaktion entscheidet im Admin.
#
# Liest die Tabellen und Textebenen vom Server (Convex-Daten, S3 ueber den
# Import-Worker), bearbeitet alles lokal in einem Wegwerfordner und raeumt den
# Server danach auf.
set -eu

SERVER=root@62.108.44.118
CODE=/opt/weltkrieg-digital/code
ENVF=/opt/weltkrieg-digital/convex-deploy.env
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ARCHIV=""
ANWENDEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --archiv) ARCHIV=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --anwenden) ANWENDEN=1; shift ;;
    *) echo "Unbekannt: $1" >&2; exit 2 ;;
  esac
done

D=${TITEL_PRUEFEN_DIR:-$(mktemp -d)}
mkdir -p "$D/cov" "$D/inner" "$D/bund"
echo "Arbeitsordner: $D"
R=/tmp/wk-titel-$$

convex() { # convex <befehl …> auf dem Server, im Code-Stand der Anlage
  ssh -o BatchMode=yes "$SERVER" "docker run --rm --network host -v $CODE:/app -v $R:/out -w /app --env-file $ENVF node:22-alpine npx convex $*" 2>/dev/null
}

ssh -o BatchMode=yes "$SERVER" "mkdir -p $R"
trap 'ssh -o BatchMode=yes "$SERVER" "rm -rf $R; docker exec wkdigital-import-worker-1 rm -rf /tmp/wk-titel-tx /tmp/wk-titel-keys.txt" >/dev/null 2>&1 || true' EXIT

echo "1/4 Tabellen"
convex data issues --limit 10000 --format jsonl > "$D/issues.jsonl"
convex data publications --limit 1000 --format jsonl > "$D/pubs.jsonl"
convex data issueSources --limit 10000 --format jsonl > "$D/sources.jsonl"

echo "2/4 Ablageschluessel der Textebenen (Schnappschuss, danach geloescht)"
convex export --path /out/e.zip >/dev/null
python3 -I - "$D/sources.jsonl" > "$D/text-ids.txt" <<'EOF'
import json, sys
for l in open(sys.argv[1]):
    if not l.startswith("{"): continue
    s = json.loads(l)
    if s.get("kind") == "text" and s.get("role") in ("cover", "inner"):
        print(s["assetId"], s["issueId"], "cov" if s["role"] == "cover" else "inner")
EOF
scp -q "$D/text-ids.txt" "$SERVER:$R/text-ids.txt"
ssh -o BatchMode=yes "$SERVER" "python3 -I - $R" <<'EOF'
import json, sys, zipfile
r = sys.argv[1]
want = {}
for l in open(f"{r}/text-ids.txt"):
    a, i, rolle = l.split()
    want[a] = (i, rolle)
with zipfile.ZipFile(f"{r}/e.zip") as z, z.open("assets/documents.jsonl") as f, open(f"{r}/keys.txt", "w") as out:
    for l in f:
        a = json.loads(l)
        if a["_id"] in want:
            i, rolle = want[a["_id"]]
            out.write(f"{rolle}/{i}.json {a['key']}\n")
EOF
ssh -o BatchMode=yes "$SERVER" "rm -f $R/e.zip"

echo "3/4 Textebenen aus der Ablage"
ssh -o BatchMode=yes "$SERVER" "docker cp $R/keys.txt wkdigital-import-worker-1:/tmp/wk-titel-keys.txt && docker exec wkdigital-import-worker-1 python3 -I -c '
import os, boto3
s3 = boto3.client(\"s3\", endpoint_url=os.environ[\"S3_ENDPOINT_URL\"])
for zeile in open(\"/tmp/wk-titel-keys.txt\"):
    ziel, key = zeile.split(maxsplit=1)
    os.makedirs(os.path.dirname(\"/tmp/wk-titel-tx/\" + ziel), exist_ok=True)
    s3.download_file(\"emag-media\", key.strip(), \"/tmp/wk-titel-tx/\" + ziel)
' && docker cp wkdigital-import-worker-1:/tmp/wk-titel-tx/. $R/tx/ && tar czf $R/tx.tgz -C $R/tx ."
scp -q "$SERVER:$R/tx.tgz" "$D/tx.tgz"
tar xzf "$D/tx.tgz" -C "$D" && rm -f "$D/tx.tgz"

echo "4/4 Pruefen"
(cd "$ROOT/web" && npx esbuild src/admin/heftTitel.ts src/admin/umschlagTitel.ts src/admin/heftarchiv.ts \
  --bundle --format=esm --outdir="$D/bund" --log-level=warning &&
  npx esbuild src/lib/reihen.ts --bundle --format=esm --outfile="$D/bund/reihen.js" --log-level=warning \
  --define:import.meta.env.VITE_MARKE='"weltkrieg"')
node "$ROOT/tools/weltkrieg/titel_pruefen.mjs" "$D" ${ARCHIV:+"$ARCHIV"}

[ "$ANWENDEN" = 1 ] || { echo; echo "Nur Bericht. Mit --anwenden schreiben."; exit 0; }

echo
echo "Anwenden"
python3 -I - "$D" <<'EOF'
import json, sys, os
d = sys.argv[1]
e = json.load(open(os.path.join(d, "ergebnis.json")))
os.makedirs(os.path.join(d, "pakete"), exist_ok=True)
def pakete(name, liste, feld):
    for n in range(0, len(liste), 15):
        json.dump({"eintraege": [feld(x) for x in liste[n:n + 15]]},
                  open(os.path.join(d, "pakete", f"{name}-{n // 15:03d}.json"), "w"), ensure_ascii=False)
pakete("titel", e["titel"], lambda x: {"issueId": x["issueId"], "alt": x["alt"], "titel": x["titel"]})
pakete("pruefen", e["pruefen"], lambda x: {"issueId": x["issueId"], "pruefen": x["pruefen"]})
EOF
if ls "$D/pakete/"*.json >/dev/null 2>&1; then
  scp -q "$D/pakete/"*.json "$SERVER:$R/"
  for f in "$D/pakete/"*.json; do
    b=$(basename "$f")
    case "$b" in titel-*) fn=devtools:titelBerichtigenInternal ;; *) fn=devtools:titelPruefenInternal ;; esac
    printf '%s: ' "$b"
    ssh -o BatchMode=yes "$SERVER" "docker run --rm --network host -v $CODE:/app -v $R:/out -w /app --env-file $ENVF node:22-alpine sh -c 'npx convex run $fn \"\$(cat /out/$b)\"'" 2>&1 | grep -v "npm notice" | tr -d '\n' | cut -c1-200
    echo
  done
else
  echo "Nichts zu schreiben."
fi
