#!/usr/bin/env bash
# Unsichtbares Wasserzeichen aus einem gefundenen Bild lesen: wer hat die
# Seite (oder das Artikelbild) gelesen? Laeuft im Gateway-Container auf dem
# Verlagsserver, weil nur dort Schluessel und Originale liegen.
#
#   tools/wasserzeichen-lesen.sh fund.jpg --heft <heftId> --seite <index ab 0>
#   tools/wasserzeichen-lesen.sh fund.png --asset <assetId>
#
# Das Bild sollte die ganze Seite bzw. das ganze Artikelbild zeigen; Rand,
# leichter Anschnitt, andere Groesse und JPEG sind kein Problem.
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,10p' "$0"; exit 2; }
SERVER=root@62.108.44.118
BEHAELTER=code-tile-service-1
bild=$1; shift
ziel=/tmp/wz-$$.${bild##*.}
scp -q "$bild" "$SERVER:$ziel"
ssh "$SERVER" "docker cp $ziel $BEHAELTER:$ziel && rm -f $ziel && \
  docker exec $BEHAELTER python wasserzeichen.py $ziel $* ; \
  r=\$?; docker exec $BEHAELTER rm -f $ziel; exit \$r"
