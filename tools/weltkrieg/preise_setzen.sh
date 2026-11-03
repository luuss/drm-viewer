#!/bin/bash
# Preise von der Titelseite in alle Weltkrieg-Hefte ohne Preis eintragen.
cd "$(dirname "$0")"; mkdir -p ../../_scratch/wk-preise; cd ../../_scratch/wk-preise
ID='{"subject":"q973ryepe70ds5b3bczf34ewsn8hhhf1|x","issuer":"x","tokenIdentifier":"x"}'
../../tools/weltkrieg/wkrun.sh --identity "$ID" issues:listForEditors '{}' > hefte.json
OHNE=$(python3 -I -c "import json; print(json.dumps([i['_id'] for i in json.load(open('hefte.json')) if not i.get('priceAmountCents')]))")
echo "Hefte ohne Preis: $(python3 -I -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$OHNE")"
scp -q ../../tools/weltkrieg/preise_lesen.py root@62.108.44.118:/root/wk_preise_lesen.py
ssh root@62.108.44.118 "docker cp /root/wk_preise_lesen.py wkdigital-import-worker-1:/tmp/p.py && docker exec wkdigital-import-worker-1 python /tmp/p.py '$OHNE'" > preise.json
python3 -I -c "
import json; p=json.load(open('preise.json')); h={i['_id']:i for i in json.load(open('hefte.json'))}
for k,v in p.items(): print(f'{v/100:6.2f} €  {h[k][\"publicationName\"]} {h[k][\"issueNumber\"]} {h[k][\"title\"]}')
print(len(p), 'Preise gefunden')"
for K in $(python3 -I -c "import json; print(' '.join(json.load(open('preise.json'))))"); do
  C=$(python3 -I -c "import json,sys; print(json.load(open('preise.json'))[sys.argv[1]])" "$K")
  ../../tools/weltkrieg/wkrun.sh --identity "$ID" issues:update "{\"issueId\":\"$K\",\"priceAmountCents\":$C}" >/dev/null
done
echo fertig
# Ohne Preis auf dem Umschlag (E-Book-Fassungen "ohne Preis"): der Preis des
# neuesten Hefts derselben Reihe, das einen traegt.
../../tools/weltkrieg/wkrun.sh --identity "$ID" issues:listForEditors '{}' > hefte.json
python3 -I - > reihenpreis.json <<'PY'
import json, re
h = json.load(open("hefte.json"))
nr = lambda i: int(re.match(r"\d+", i.get("issueNumber") or "0").group()) if re.match(r"\d+", i.get("issueNumber") or "") else 0
best = {}
for i in h:
    if i.get("priceAmountCents"):
        p = i["publicationName"]
        if p not in best or nr(i) > nr(best[p]): best[p] = i
out = {i["_id"]: best[i["publicationName"]]["priceAmountCents"] for i in h if not i.get("priceAmountCents") and i["publicationName"] in best}
for k, v in out.items():
    i = next(x for x in h if x["_id"] == k); print(f"  Reihenpreis {v/100:.2f} € {i['publicationName']} {i['issueNumber']} {i['title']}", file=__import__("sys").stderr)
print(json.dumps(out))
PY
for K in $(python3 -I -c "import json; print(' '.join(json.load(open('reihenpreis.json'))))"); do
  C=$(python3 -I -c "import json,sys; print(json.load(open('reihenpreis.json'))[sys.argv[1]])" "$K")
  ../../tools/weltkrieg/wkrun.sh --identity "$ID" issues:update "{\"issueId\":\"$K\",\"priceAmountCents\":$C}" >/dev/null
done
echo "Reihenpreise gesetzt: $(python3 -I -c "import json; print(len(json.load(open('reihenpreis.json'))))")"
