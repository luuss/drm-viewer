# Automatisches Produktionsdeployment mit Dokploy

Alles laeuft in einer einzigen Docker-Compose-Anwendung in Dokploy: Convex-
Backend, Postgres, MinIO, Kachel-Gateway, Import-Worker und Weboberflaeche.
Eine Convex-Cloud gibt es nicht mehr. Der Entwicklungsrechner braucht weder
Vite noch Worker, Kacheldienst oder Tunnel — gearbeitet wird gegen die echte
Anlage, ausgeliefert wird durch `git push`.

Jeder Push auf `main` laeuft durch eine einzige Kette in GitHub Actions
(`.github/workflows/deploy-production.yml`):

1. **Pruefen** — Convex-Tests, Bau der Weboberflaeche, Tests der Extraktion und
   eine Syntaxpruefung der Compose-Datei.
2. **Ausliefern**, nur bei gruenen Pruefungen und in dieser Reihenfolge:
   Dokploy anstossen, warten bis das Backend antwortet, Convex-Funktionen
   ausliefern, Umgebungswerte des Backends sichern, zuletzt ein Rauchtest
   gegen die laufende Seite.

Die Reihenfolge hat sich mit dem Umzug umgedreht: frueher lag das Backend in
der Cloud und war immer da, heute startet es im selben Stapel. Funktionen
koennen also erst hinein, wenn Dokploy den Stapel hochgezogen hat.

Der Webhook bestaetigt nur, dass Dokploy den Auftrag angenommen hat. Ob der Bau
gelingt, sagt er nicht. Deshalb wartet der Lauf danach, bis die Seite genau das
JavaScript-Bundle ausliefert, das die Pruefung gebaut hat — Vite benennt es nach
dem Inhalt, es ist also ein Fingerabdruck des Standes. Erst dann gilt die
Auslieferung als gelungen.

Eine Grenze hat das: aendert ein Commit nur das Backend oder die Extraktion,
bleibt der Fingerabdruck der Oberflaeche derselbe und die Wartezeit entfaellt.
Ein fehlgeschlagener Bau von Kacheldienst oder Import-Worker faellt dann nicht
auf. Fuer diese Faelle bleibt das Bauprotokoll in Dokploy die Wahrheit.

**Dokploy erfaehrt bewusst nichts von Pushes.** Der Dienst ist nicht ueber die
Dokploy-GitHub-App angebunden, sondern klont das oeffentliche Repository direkt
(`sourceType: git`). Solange die App angebunden war, startete Dokploy bei jedem
Push von selbst — gemessen am 21.09.2026 liefen dadurch zwei Rollouts
nebeneinander, einer um 16:53:44 direkt beim Push und einer um 16:54:46 nach den
Tests. Der erste lief an den Tests vorbei; ein roter Test haette ein kaputtes
Deployment nicht mehr aufhalten koennen. Jetzt loest ausschliesslich der
Workflow aus, ueber den Deploy-Webhook des Dienstes.

## Wo die Daten liegen

Dokploy klont den Quellstand bei jedem Deployment neu — der Checkout ist also
fluechtig. Alles, was bleiben muss, liegt deshalb im Ordner der Anwendung auf
dem Server:

| Pfad auf dem Server | Inhalt |
|---|---|
| `/etc/dokploy/compose/<dienst>/files/postgres` | Die ganze Datenbank: Nutzer, Hefte, Artikel, Kaeufe |
| `/etc/dokploy/compose/<dienst>/files/minio` | Alle Dateien: Seiten, Bilder, Satz- und Druckdateien |

In der Compose-Datei stehen sie als `../files/postgres` und `../files/minio`.
Ein Deployment, ein Neustart oder ein Neubau der Abbilder fasst sie nicht an.
Geloescht werden sie nur mit dem Dienst selbst. **Die Sicherung dieser beiden
Ordner ist die Sicherung der Anwendung.**

## 1. Dokploy auf einem EU-Server

Falls noch keine Dokploy-Instanz vorhanden ist, einen EU-VPS mit Ubuntu 24.04,
mindestens 4 CPU-Kernen, 8 GB RAM und ausreichend SSD-Platz verwenden. Dokploy
selbst benoetigt freie Ports 80, 443 und bei der Ersteinrichtung 3000. Die
Installation erfolgt nach der offiziellen Dokploy-Anleitung. Vor dem echten
Betrieb SSH absichern, nur 22/80/443 oeffnen und die Dokploy-Oberflaeche ueber
eine HTTPS-Domain oder ein VPN erreichbar machen.

## 2. Compose-Dienst in Dokploy anlegen

1. Ein Projekt und darin einen Dienst vom Typ **Docker Compose** erstellen.
2. Als Quelle **Git** waehlen, nicht GitHub: Adresse
   `https://github.com/luuss/drm-viewer.git`, Zweig `main`. Das Repository ist
   oeffentlich, ein Schluessel ist nicht noetig. Die Dokploy-GitHub-App bleibt
   bewusst aussen vor, weil Dokploy sonst bei jedem Push von selbst startet.
3. Als Compose-Pfad
   `./docker-compose.dokploy.yml` eintragen.
4. **Docker Compose** verwenden, nicht Docker Stack: Die Images werden direkt
   aus dem Checkout gebaut.
5. **Auto Deploy eingeschaltet lassen, Trigger `push`.** Der Deploy-Webhook
   haengt am selben Schalter wie der Push-Trigger: ist Auto Deploy aus,
   antwortet er mit
   `{"message":"Automatic deployments are disabled for this compose"}`.
   Mit Trigger `tag` antwortet er `{"message":"Branch Not Match"}`.

   Der Webhook will in der Form aufgerufen werden, in der GitHub selbst ihn
   ruft: Kopfzeile `x-github-event: push` und im Rumpf `{"ref":"refs/heads/main"}`.
   Fehlt eines davon, kommt wieder `Branch Not Match` — und zwar mit Code 301,
   den `curl` nicht als Fehler wertet. Der Workflow prueft deshalb den Rumpf auf
   `successfully` und nicht nur den Code.
6. Die Webhook-Adresse steht unter **Compose → Deployments → Webhook URL** und
   gehoert als Secret `DOKPLOY_DEPLOY_URL` ins Repository. Sie traegt ein
   Merkmal, das nur diesen einen Dienst ausloesen kann — ein Dokploy-API-
   Schluessel mit Vollzugriff haette in einem oeffentlichen Repository nichts zu
   suchen.

Wo die Nutzdaten liegen, steht oben unter "Wo die Daten liegen". Der Checkout
ist fluechtig, `../files/` nicht.

## 3. Umgebungswerte in Dokploy

Den Inhalt von `.env.dokploy.example` unter **Compose → Environment** einfuegen
und alle Platzhalter ersetzen. Die Zufallswerte erzeugt:

```bash
openssl rand -hex 32     # CONVEX_INSTANCE_SECRET, TILE_SERVICE_SECRET, EXTRACT_SERVICE_SECRET
openssl rand -hex 24     # POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD
echo "eigen:$(openssl rand -base64 32)"   # MINIO_KMS_SECRET_KEY
```

Drei Werte muessen **in Dokploy und in GitHub gleich** sein, weil beide Seiten
sie brauchen: `TILE_SERVICE_SECRET`, `EXTRACT_SERVICE_SECRET` und die
MinIO-Zugangsdaten. Der Workflow traegt sie im Convex-Backend ein; der Stapel
gibt sie den Diensten. Stimmen sie nicht ueberein, weist das Backend
Kacheldienst und Import-Worker ab.

`CONVEX_INSTANCE_SECRET` ist der wichtigste Wert: aus ihm leitet sich der
Admin-Schluessel ab. Wird er geaendert, gilt jeder bisherige Schluessel nicht
mehr und der Workflow kommt nicht mehr ins Backend.

## 4. Domains in Dokploy

Vier DNS-A/AAAA-Eintraege auf den Dokploy-Server zeigen lassen, danach unter
**Compose → Domains** vier HTTPS-Domains anlegen:

| Domain | Service | Container-Port | wofuer |
|---|---|---:|---|
| `d.chuk.dev` | `web` | `80` | Die Seite selbst |
| `api.d.chuk.dev` | `convex-backend` | `3210` | Datenverbindung des Browsers |
| `hooks.d.chuk.dev` | `convex-backend` | `3211` | HTTP-Endpunkte (Shop, Stripe) |
| `medien.d.chuk.dev` | `minio` | `9000` | Browser laedt Heftdateien direkt hoch |

Optional fuer die Convex-Konsole: `konsole.d.chuk.dev` auf
`convex-dashboard:6791`. Sie zeigt Tabellen, Protokolle und laufende
Funktionen; fuer den Betrieb ist sie nicht noetig.

Der Kacheldienst bekommt **keine** eigene Domain: die Weboberflaeche reicht
`/api/...` im internen Netz an `tile-service:8000` weiter.

## 5. Erster Start: Admin-Schluessel und Anmeldung

Nach dem ersten Deploy einmalig auf dem Server den Admin-Schluessel erzeugen —
er bleibt gueltig, solange `CONVEX_INSTANCE_SECRET` steht:

```bash
cd /etc/dokploy/compose/<dienst>/code
docker compose -f docker-compose.dokploy.yml exec convex-backend ./generate_admin_key.sh
```

Die Ausgabe (`emagazin|017...`) gehoert als GitHub-Secret
`CONVEX_SELF_HOSTED_ADMIN_KEY` ins Repository. Ohne ihn kann der Workflow keine
Funktionen ausliefern.

Den ersten Zugang legt die Anwendung selbst an: die Adresse aus der
Repository-Variablen `ADMIN_EMAILS` bekommt beim Registrieren auf
`https://d.chuk.dev` sofort Adminrechte. Danach kann die Variable stehen
bleiben; Rollen haengen ab dann am Nutzer.

## 6. GitHub Actions konfigurieren

Unter **Repository → Settings → Secrets and variables → Actions** eintragen.

Secrets:

| Name | Inhalt |
|---|---|
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | Ausgabe von `generate_admin_key.sh` |
| `DOKPLOY_DEPLOY_URL` | Deploy-Webhook des Compose-Dienstes |
| `MINIO_ROOT_USER` | wie in Dokploy |
| `MINIO_ROOT_PASSWORD` | wie in Dokploy |
| `TILE_SERVICE_SECRET` | wie in Dokploy |
| `EXTRACT_SERVICE_SECRET` | wie in Dokploy |
| `RESEND_API_KEY` | optional, fuer Mailversand |
| `STRIPE_SECRET_KEY` | optional, fuer den Verkauf |
| `SHOP_WEBHOOK_SECRET` | optional, fuer die Shop-Schnittstelle |

Variablen:

| Name | Inhalt |
|---|---|
| `VITE_CONVEX_URL` | `https://api.d.chuk.dev` — wird ins Bundle gebaut |
| `CONVEX_SELF_HOSTED_URL` | dieselbe Adresse; Ziel von `convex deploy` |
| `PUBLIC_WEB_ORIGIN` | `https://d.chuk.dev` |
| `PUBLIC_MEDIA_ORIGIN` | `https://medien.d.chuk.dev` |
| `ADMIN_EMAILS` | Adresse des ersten Zugangs |
| `MEDIA_BUCKET` | optional, Vorgabe `emag-media` |
| `RESEND_FROM_EMAIL` | optional, Absender |

Die Umgebungswerte des Backends setzt der Workflow bei jedem Lauf selbst
(`scripts/convex-env-sichern.mjs`). Er schreibt nur, was fehlt oder abweicht,
und erzeugt die Schluessel der Anmeldung (`JWT_PRIVATE_KEY`, `JWKS`) genau
einmal — wuerde er sie jedes Mal neu erzeugen, waere nach jedem Deployment
jeder angemeldete Leser ausgesperrt.

Fuer den automatischen Rollout darf das GitHub-Environment `production` keine
manuelle Freigaberegel besitzen, sonst bleibt jeder Push auf eine Bestaetigung
warten.

## 7. Erster Rollout

1. In Dokploy **Deploy** ausfuehren und die Protokolle von `postgres`, `minio`,
   `convex-backend`, `web`, `tile-service` und `import-worker` durchsehen.
2. Admin-Schluessel erzeugen (Abschnitt 5) und als Secret hinterlegen.
3. Einen kleinen Commit nach `main` pushen. Der Workflow liefert die Funktionen
   aus, setzt die Umgebungswerte und prueft die Seite.
4. Auf `https://d.chuk.dev` mit der Adresse aus `ADMIN_EMAILS` registrieren.
5. Ein Heft per Drag-and-Drop importieren und im Reader pruefen.

Ab dann genuegt `git push`.

## 8. Sicherung

Gesichert werden zwei Ordner auf dem Server:

```bash
tar czf sicherung-$(date +%F).tgz \
    /etc/dokploy/compose/<dienst>/files/postgres \
    /etc/dokploy/compose/<dienst>/files/minio
```

Sauberer ist eine Sicherung der Datenbank im laufenden Betrieb:

```bash
docker compose exec postgres pg_dump -U convex emagazin | gzip > datenbank-$(date +%F).sql.gz
```

Die Dateien in MinIO lassen sich mit `mc mirror` auf ein zweites Ziel spiegeln.

## 9. Der lokale Aufbau

`docker-compose.selfhost.yml` bleibt fuer den Aufbau auf dem eigenen Rechner:
dieselben Dienste, aber mit Host-Ports und Caddy statt Dokploy-Domains. Er ist
zum Ausprobieren da, nicht fuer den Betrieb.
