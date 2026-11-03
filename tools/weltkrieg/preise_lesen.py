"""Im Container wkdigital-import-worker-1: Preis von der Titelseite je Heft.
Liest uploads/<heft>/*textebene-umschlag.json (neueste), Tafel front_cover,
nimmt den groessten ungedrehten Eintrag mit "€ x,xx". Ausgabe JSON {heft: cent}."""
import json, os, re, sys, boto3
s = boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT_URL"],
                 aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
                 aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"], region_name="us-east-1")
hefte = json.loads(sys.argv[1])
PREIS = re.compile(r"€\s*(\d{1,2}),(\d{2})")
out = {}
for h in hefte:
    objs = s.list_objects_v2(Bucket="emag-media", Prefix=f"uploads/{h}/").get("Contents", [])
    k = sorted((o["Key"] for o in objs if o["Key"].endswith("textebene-umschlag.json")))
    if not k:
        continue
    d = json.loads(s.get_object(Bucket="emag-media", Key=k[-1])["Body"].read())
    front = next((p for p in d["pages"] if p.get("role") == "front_cover"), None)
    if not front:
        continue
    items = [i for i in front["items"] if len(i) < 7 or not i[6]]
    # "€" und Betrag koennen getrennte Stuecke sein: Zeilen zusammennehmen.
    treffer = []
    for n, i in enumerate(items):
        text = i[0]
        # Manche Schriften kodieren das Euro-Zeichen als "t" (Legion, DMZ).
        if text.strip() in ("€", "t") and n + 1 < len(items):
            text = "€ " + items[n + 1][0]
        m = PREIS.search(text)
        if m and i[5] >= 12:
            treffer.append((i[5], int(m.group(1)) * 100 + int(m.group(2))))
    if treffer:
        out[h] = max(treffer)[1]
        continue
    # Freikorps, Legion: der Preis steht nur hochkant am Rand,
    # "Deutschland € 3,95 • Österreich/Italien/Lux. € 4,65 • Schweiz CHF 5,20".
    rand = " ".join(i[0] for i in front["items"] if len(i) >= 7 and i[6])
    m = re.search(r"Deutschland\s*€\s*(\d{1,2}),(\d{2})", rand) or PREIS.search(rand)
    if m:
        out[h] = int(m.group(1)) * 100 + int(m.group(2))
print(json.dumps(out))
