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

## 5. Umgebungswerte im Backend setzen

```bash
npx convex env set STRIPE_SECRET_KEY sk_live_...
npx convex env set STRIPE_WEBHOOK_SECRET whsec_...
npx convex env set RESEND_API_KEY re_...
npx convex env set RESEND_FROM_EMAIL "E-Magazin <noreply@example.de>"
npx convex env set APP_PUBLIC_URL https://lesen.example.de
npx convex env set TILE_SERVICE_SECRET <derselbe Wert wie in .env.selfhost>
npx convex env set EXTRACT_SERVICE_URL http://extract-service:8100
npx convex env set ADMIN_EMAILS redaktion@example.de
npx convex env set MAX_ACTIVE_SESSIONS 3
npx convex env set REQUIRE_EMAIL_VERIFICATION false
```

## 6. Stripe

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

## 7. Sicherung

`deploy/backup.sh` legt einen Datenbank-Dump und eine Kopie der Dateien ab.
Als Cron einrichten:

```
0 3 * * * /opt/emagazin/deploy/backup.sh >> /var/log/emagazin-backup.log 2>&1
```

Wiederherstellung: Dump mit `psql` einspielen, Dateien nach `/data` im
MinIO-Volumen zurueckschreiben, danach Backend neu starten.

## 8. Pruefen, ob alles laeuft

```bash
curl -s https://api.example.de/version
curl -s https://tiles.example.de/health
docker compose -f docker-compose.selfhost.yml exec extract-service \
  wget -qO- http://localhost:8100/health
```
