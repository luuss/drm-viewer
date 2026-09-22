# Selbst betreiben

Alles laeuft auf einer eigenen Maschine: Convex-Backend, Postgres, MinIO,
Kacheldienst, Extraktionsdienst, Weboberflaeche und TLS-Proxy. Kein Dienst
ausser Stripe und dem Mailversand liegt ausserhalb.

## 1. Voraussetzungen

* Docker mit Compose-Plugin
* Vier DNS-Namen auf die Maschine:
  * `lesen.example.de` — Weboberflaeche
  * `api.example.de` — Convex-Anwendung (Port 3210)
  * `hooks.example.de` — Convex-HTTP-Endpunkte, dorthin zeigt der Stripe-Webhook (Port 3211)
  * `tiles.example.de` — Kacheldienst

## 2. Datei `.env.selfhost` anlegen

```
POSTGRES_PASSWORD=<lang und zufaellig>
MINIO_ROOT_USER=convexminio
MINIO_ROOT_PASSWORD=<lang und zufaellig>

CONVEX_INSTANCE_NAME=emagazin
CONVEX_INSTANCE_SECRET=<32 Byte hex, siehe unten>
CONVEX_CLOUD_ORIGIN=https://api.example.de
CONVEX_SITE_ORIGIN=https://hooks.example.de

WEB_DOMAIN=lesen.example.de
API_DOMAIN=api.example.de
HOOKS_DOMAIN=hooks.example.de
TILE_DOMAIN=tiles.example.de
PUBLIC_WEB_ORIGIN=https://lesen.example.de
PUBLIC_TILE_ORIGIN=https://tiles.example.de

TILE_SERVICE_SECRET=<32 Byte hex>
```

Zufallswerte erzeugen:

```bash
openssl rand -hex 32
```

## 3. Starten

```bash
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
```

MinIO braucht beim ersten Lauf die Eimer. Einmalig:

```bash
docker compose -f docker-compose.selfhost.yml exec minio \
  sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
         for b in convex-exports convex-imports convex-modules convex-files convex-search; do
           mc mb -p "local/$b"; done'
```

## 4. Funktionen ausspielen

Admin-Schluessel aus dem Backend holen und Funktionen deployen:

```bash
docker compose -f docker-compose.selfhost.yml exec convex-backend \
  ./generate_admin_key.sh

export CONVEX_SELF_HOSTED_URL=https://api.example.de
export CONVEX_SELF_HOSTED_ADMIN_KEY=<Schluessel aus dem Befehl oben>
npx convex deploy
```

## 5. Medien-Eimer anlegen

```bash
docker compose -f docker-compose.selfhost.yml exec minio \
  sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
         mc mb -p local/emag-media'
```

Der Eimer bleibt privat. Seitenbilder und Artikelbilder gehen ausschliesslich
ueber das Kachel-Gateway an den Browser; die Druckdateien verlassen den Server
gar nicht.

## 6. Umgebungswerte im Backend setzen

```bash
npx convex env set STRIPE_SECRET_KEY sk_live_...
npx convex env set STRIPE_WEBHOOK_SECRET whsec_...
npx convex env set RESEND_API_KEY re_...
npx convex env set RESEND_FROM_EMAIL "E-Magazin <noreply@example.de>"
npx convex env set APP_PUBLIC_URL https://lesen.example.de
npx convex env set TILE_SERVICE_SECRET <derselbe Wert wie in .env.selfhost>
npx convex env set EXTRACT_SERVICE_SECRET <eigener Wert fuer den Worker>
npx convex env set SHOP_WEBHOOK_SECRET <Wert fuer die Shop-Schnittstelle>
npx convex env set ADMIN_EMAILS redaktion@example.de
npx convex env set MAX_ACTIVE_SESSIONS 2
npx convex env set SUBSCRIPTION_GRACE_MS 259200000
npx convex env set REQUIRE_EMAIL_VERIFICATION false
```

## 7. Stripe

Webhook-Endpunkt: `https://hooks.example.de/stripe/webhook`

Ereignisse abonnieren:

```
checkout.session.completed
customer.created customer.updated customer.deleted
customer.subscription.created customer.subscription.updated customer.subscription.deleted
invoice.created invoice.finalized invoice.updated invoice.paid invoice.payment_failed
payment_intent.succeeded payment_intent.payment_failed
```

Im Stripe-Konto zusaetzlich einstellen:

* Kundenportal aktivieren (Kuendigung, Zahlungsmittel, Rechnungen).
* Steuersatz fuer E-Publikationen pruefen. In Deutschland gilt fuer
  E-Zeitschriften der ermaessigte Satz. Falscher Satz kostet die Differenz.
* SEPA-Lastschrift als Zahlart freischalten.

Die erste Anmeldung mit einer Adresse aus `ADMIN_EMAILS` bekommt die Rolle
Admin. Danach werden Rollen in der Oberflaeche vergeben; die Liste ist nur
der Erstzugang.

## 8. Sicherung

`deploy/backup.sh` legt einen Datenbank-Dump und eine Kopie der Dateien ab.
Als Cron einrichten:

```
0 3 * * * /opt/emagazin/deploy/backup.sh >> /var/log/emagazin-backup.log 2>&1
```

Wiederherstellung: Dump mit `psql` einspielen, Dateien nach `/data` im
MinIO-Volumen zurueckschreiben, danach Backend neu starten.

## 9. Pruefen, ob alles laeuft

```bash
curl -s https://api.example.de/version
curl -s https://tiles.example.de/health
docker compose -f docker-compose.selfhost.yml exec extract-service \
  wget -qO- http://localhost:8100/health
```


## 10. Referenzfall: eigene Subdomain

Der geprueft dokumentierte Fall ist der Betrieb unter einer eigenen Subdomain,
etwa `digital.lesenundschenken.de`. Im Caddyfile stehen vier Namen:

```
digital.lesenundschenken.de  -> web:80
api.lesenundschenken.de      -> convex-backend:3210
hooks.lesenundschenken.de    -> convex-backend:3211
tiles.lesenundschenken.de    -> tile-service:8000
```

In `.env.selfhost` dazu:

```
WEB_DOMAIN=digital.lesenundschenken.de
API_DOMAIN=api.lesenundschenken.de
HOOKS_DOMAIN=hooks.lesenundschenken.de
TILE_DOMAIN=tiles.lesenundschenken.de
PUBLIC_WEB_ORIGIN=https://digital.lesenundschenken.de
PUBLIC_TILE_ORIGIN=https://tiles.lesenundschenken.de
CONVEX_CLOUD_ORIGIN=https://api.lesenundschenken.de
CONVEX_SITE_ORIGIN=https://hooks.lesenundschenken.de
```

Der Betrieb unter einem Unterpfad (`lesenundschenken.de/digital/`) geht auch:
`VITE_BASE_PATH=/digital/` setzen und im Proxy entsprechend weiterleiten. Die
Anwendung verdrahtet keine Wurzel-URLs.

## 11. Aufbereitung pruefen

```bash
docker compose -f docker-compose.selfhost.yml logs -f import-worker
```

Ein Auftrag meldet Start, Fortschritt je Seite und am Ende, wie viele Artikel
uebernommen wurden. Bleibt ein Auftrag haengen, laeuft seine Sperre aus und der
naechste Worker versucht ihn erneut; nach drei Versuchen steht er als Fehler in
der Redaktionsansicht.

Ohne wartenden Auftrag vergroessert der Worker sein Abfrageintervall von
`WORKER_POLL_SECONDS` (Standard 5 Sekunden) schrittweise bis
`WORKER_IDLE_POLL_MAX_SECONDS` (Standard 60 Sekunden). Das senkt die Convex-
Funktionsaufrufe im Leerlauf um mehr als 90 Prozent. Nach einem bearbeiteten
Auftrag beginnt er wieder mit dem kurzen Intervall.

## Was beim ersten Probelauf auffiel

Der Aufbau wurde am 22.09.2026 zum ersten Mal wirklich gestartet. Vier Punkte
standen dem im Weg; alle sind in der Compose-Datei behoben, hier stehen sie,
damit man sie bei einer eigenen Installation wiedererkennt.

**Die Datenbank muss heissen wie die Instanz.** Das Convex-Backend verbindet
sich mit einer Datenbank, deren Name `INSTANCE_NAME` entspricht. Legt Postgres
sie unter einem anderen Namen an, startet das Backend nicht und meldet
`database "emagazin" does not exist`.

**MinIO kennt keine Bucket-Unterdomaenen.** Ohne
`AWS_S3_FORCE_PATH_STYLE=true` sucht der S3-Client nach
`convex-modules.minio` und scheitert an der Namensaufloesung
(`dns error: failed to lookup address information`).

**MinIO braucht einen Schluessel fuer die serverseitige Verschluesselung.**
Das Convex-Backend legt seine Dateien verschluesselt ab. Fehlt
`MINIO_KMS_SECRET_KEY`, lehnt MinIO jeden Upload mit
`Server side encryption specified but KMS is not configured` ab. Erzeugen:

```bash
echo "emagazin-key:$(openssl rand -base64 32)"
```

**Der Medienspeicher muss von aussen erreichbar sein.** Der Browser laedt die
Heftdateien direkt dorthin, nicht ueber den Server. Im Betrieb steht Caddy
davor, lokal genuegt ein eigener Port (`MINIO_PORT`, Vorgabe 9100) — 9000 ist
oft schon belegt.

Dazu kam ein Fehler im Anwendungscode, der nur mit MinIO auftritt: das AWS-SDK
rechnet seit Version 3.729 zu jedem `PutObject` eine Pruefsumme und nimmt sie
in die Signatur auf. Der Browser sendet den Kopf beim direkten Upload nicht
mit, also antwortet der Medienspeicher mit 403. `convex/uploads.ts` schaltet
die Pruefsumme deshalb ab.

### Bilder aus dem Medienspeicher

Liegen die Dateien in einem Eimer statt in der Convex-Ablage, hat Convex keine
Adresse fuer den Browser. Titelbilder und Artikelbilder gehen deshalb ueber das
Kachel-Gateway (`/api/asset/<assetId>.jpg`), das den Zugang hat und die
Lesesitzung prueft. Ein Titelbild ist frei, weil es im Kiosk steht; alles
andere braucht eine gueltige Sitzung fuer genau dieses Heft. Damit Convex die
Adresse des Gateways kennt, muss `PUBLIC_TILE_ORIGIN` gesetzt sein.

### Erster Start, Kurzfassung

```bash
cp .env.selfhost.example .env.selfhost      # Geheimnisse ersetzen
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d
docker exec <backend-container> ./generate_admin_key.sh
# Schluessel als CONVEX_SELF_HOSTED_ADMIN_KEY in .env.selfhost eintragen
npx convex deploy -y --env-file .env.selfhost
```

Die Eimer legt MinIO nicht von selbst an:

```bash
docker exec <minio-container> sh -c \
  'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; \
   for b in convex-exports convex-imports convex-modules convex-files convex-search emag-media; \
   do mc mb -p local/$b; done'
```

Ein mehrzeiliger Wert wie `JWT_PRIVATE_KEY` laesst sich nur in der Form
`npx convex env set -- NAME=WERT` setzen, und die Zeilenumbrueche muessen
vorher durch Leerzeichen ersetzt werden — so schreibt es auch
`@convex-dev/auth` selbst.
