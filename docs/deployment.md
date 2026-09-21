# Automatisches Produktionsdeployment mit Dokploy

Die Produktionsstufe verwendet das bestehende Convex-EU-Cloud-Deployment.
Weboberflaeche, Kachel-Gateway und Import-Worker laufen dauerhaft als Docker-
Compose-Anwendung in Dokploy. Der Entwicklungsrechner braucht danach weder
Vite noch Worker, Kacheldienst oder Cloudflare Quick Tunnel.

Jeder Push auf `main` laeuft durch eine einzige Kette in GitHub Actions
(`.github/workflows/deploy-production.yml`):

1. **Pruefen** — Convex-Tests, Bau der Weboberflaeche, Tests der Extraktion und
   eine Syntaxpruefung der Compose-Datei.
2. **Ausliefern**, nur bei gruenen Pruefungen und in dieser Reihenfolge:
   erst die Convex-Funktionen, dann die drei Dienste in Dokploy, zuletzt ein
   Rauchtest gegen die laufende Seite.

Die Reihenfolge ist nicht beliebig: waere die Oberflaeche vor dem Backend neu,
riefe sie Funktionen auf, die es noch nicht gibt.

**Dokploy hat bewusst keinen eigenen Auto-Deploy.** Wuerde es selbst auf jeden
Push reagieren, liefe es an den Tests vorbei; ein roter Test wuerde ein kaputtes
Deployment nicht mehr aufhalten. Stattdessen stoesst der Workflow Dokploy ueber
dessen Deploy-Webhook an.

## 1. Dokploy auf einem EU-Server

Falls noch keine Dokploy-Instanz vorhanden ist, einen EU-VPS mit Ubuntu 24.04,
mindestens 4 CPU-Kernen, 8 GB RAM und ausreichend SSD-Platz verwenden. Dokploy
selbst benoetigt freie Ports 80, 443 und bei der Ersteinrichtung 3000. Die
Installation erfolgt nach der offiziellen Dokploy-Anleitung. Vor dem echten
Betrieb SSH absichern, nur 22/80/443 oeffnen und die Dokploy-Oberflaeche ueber
eine HTTPS-Domain oder ein VPN erreichbar machen.

## 2. GitHub und Compose in Dokploy verbinden

1. Unter **Git → GitHub** eine GitHub App fuer Dokploy erstellen und nur fuer
   dieses Repository freigeben.
2. Ein Projekt und darin einen Dienst vom Typ **Docker Compose** erstellen.
3. Als Repository `luuss/drm-viewer`, Branch `main` und als Compose-Pfad
   `./docker-compose.dokploy.yml` eintragen.
4. **Docker Compose** verwenden, nicht Docker Stack: Die Images werden direkt
   aus dem Checkout gebaut.
5. **Auto Deploy ausgeschaltet lassen.** Den Rollout stoesst GitHub Actions an,
   nachdem die Tests durchgelaufen sind. Die Adresse dafuer steht unter
   **Compose → Deployments → Webhook URL** und gehoert als Secret
   `DOKPLOY_DEPLOY_URL` ins Repository. Sie enthaelt ein Merkmal, das nur diesen
   einen Dienst ausloesen kann — ein Dokploy-API-Schluessel mit Vollzugriff hat
   in einem oeffentlichen Repository nichts zu suchen.

Dokploy klont den Quellstand bei jedem Deployment neu. Persistente Dateien
duerfen deshalb spaeter nur in benannten Volumes oder Dokploy File Mounts
liegen. Der aktuelle Cloud-Bridge-Stack speichert lokal keine Nutzdaten.

## 3. Umgebungswerte in Dokploy

Den Inhalt von `.env.dokploy.example` unter **Compose → Environment** einfuegen
und alle Platzhalter ersetzen. Besonders wichtig:

- `VITE_CONVEX_URL` ist die oeffentliche `.convex.cloud`-Adresse.
- `CONVEX_SITE_URL` ist die passende `.convex.site`-Adresse.
- `PUBLIC_WEB_ORIGIN` ist exakt die spaetere HTTPS-Domain der Weboberflaeche.
- `TILE_SERVICE_SECRET` und `EXTRACT_SERVICE_SECRET` sind zwei getrennte,
  zufaellige Werte, zum Beispiel aus `openssl rand -hex 32`.
- Der OpenRouter-Schluessel gehoert nur in Dokploy, niemals ins Repository.

## 4. Domains in Dokploy

Einen DNS-A/AAAA-Eintrag fuer `d.chuk.dev` auf den Dokploy-Server zeigen
lassen. Danach unter **Compose → Domains** genau eine HTTPS-Domain anlegen:

| Domain | Service | Container-Port |
|---|---|---:|
| `d.chuk.dev` | `web` | `80` |

Dokploy erzeugt die Traefik-Route und das TLS-Zertifikat. Nginx liefert die App
aus und leitet `/api/...` im internen Docker-Netz an `tile-service:8000` weiter.
Der Tile-Port wird nicht oeffentlich freigegeben. Vor dem ersten Rollout mit
**Preview Compose** pruefen, dass `d.chuk.dev` an `web:80` haengt.

## 5. Convex vorbereiten

Im Convex-Produktionsdeployment einen Production Deploy Key erzeugen. Die
beiden Dienstgeheimnisse und die echte Webadresse einmalig in Convex setzen:

```bash
npx convex env set --prod APP_PUBLIC_URL https://d.chuk.dev
npx convex env set --prod TILE_SERVICE_SECRET <derselbe Wert wie in Dokploy>
npx convex env set --prod EXTRACT_SERVICE_SECRET <derselbe Wert wie in Dokploy>
```

## 6. GitHub Actions konfigurieren

Unter **Repository → Settings → Secrets and variables → Actions** eintragen.
Das optionale Secret kann direkt im geschuetzten Environment `production`
liegen:

- `CONVEX_DEPLOY_KEY` – Deploy-Key des Deployments, an dem die Web-App haengt
- `DOKPLOY_DEPLOY_URL` – Deploy-Webhook des Compose-Dienstes in Dokploy

Beide sind Pflicht. Fehlt eines, bricht der Lauf mit einer klaren Meldung ab.
Frueher wurde der Convex-Schritt bei fehlendem Schluessel still uebersprungen
und der Lauf trotzdem gruen gemeldet — das Backend blieb alt, ohne dass es
jemandem auffiel.

Den Convex-Schluessel erzeugt die CLI, ein Besuch im Dashboard ist nicht noetig:

```bash
npx convex deployment token create github-actions
```

Der Schluessel bestimmt das Ziel. Solange die Bibliotheksdaten im Dev-Deployment
liegen und die Web-App darauf zeigt, muss es ein Schluessel fuer genau dieses
Deployment sein — er beginnt dann mit `dev:`. Ein Schluessel fuer das leere
Produktionsdeployment wuerde die Funktionen ins Leere ausliefern, waehrend die
Oberflaeche weiter woanders liest.

Repository-Variablen:

- `VITE_CONVEX_URL` – `.convex.cloud`-Adresse, gegen die gebaut wird
- `PUBLIC_WEB_ORIGIN` – oeffentliche Adresse der Seite, Ziel des Rauchtests

Fuer den automatischen Rollout darf das GitHub-Environment `production` keine
manuelle Freigaberegel besitzen, sonst bleibt jeder Push auf eine Bestaetigung
warten.

## 7. Erster Rollout und Abschalten der lokalen Dienste

Zuerst in Dokploy einmal **Deploy** ausfuehren und Web-, Tile- und Worker-Logs
kontrollieren. Danach einen kleinen Commit nach `main` pushen und pruefen, dass
der Workflow **Validate and deploy Convex** erfolgreich ist und genau ein neues
Dokploy-Deployment erzeugt.

Erst wenn Anmeldung, eine Heftseite und ein Testimport ueber die echte Domain
funktionieren, die lokalen systemd-Dienste und den Quick Tunnel deaktivieren.
So bleibt bis zur erfolgreichen Abnahme ein Rueckweg bestehen.

## 8. Spaetere vollstaendige Selbstverwaltung

`docker-compose.selfhost.yml` bleibt fuer den geplanten Umzug von Convex,
Postgres und Medien nach MinIO erhalten. Diesen Stack nicht parallel als neue
Produktion starten: Vor dem DNS-Wechsel muessen Cloud-Daten und Dateien
exportiert, importiert und geprueft werden. Andernfalls startet die Bibliothek
leer.
