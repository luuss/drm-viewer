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
ANTHROPIC_API_KEY=            # optional, nur fuer die KI-Gruppierung beim PDF-Import
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
