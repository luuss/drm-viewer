# Übergabe — Stand 26.09.2026

Kurzfassung: Die Anwendung läuft vollständig selbst betrieben auf **d.chuk.dev**
(Dokploy). Der Umzug auf den **Verlagsserver** ist zur Hälfte fertig: der Stapel
läuft dort, aber Apache reicht die Adressen noch nicht nach innen weiter.

---

## 1. Was wo läuft

| | d.chuk.dev (Dokploy) | digital.lesenundschenken.de (TLD-Host) |
|---|---|---|
| Zustand | **in Betrieb**, zwei Hefte drin | Stapel läuft, **noch nicht erreichbar** |
| Server | 65.109.85.231, Dokploy-Compose `Hefte Digital` (`jUPgSBi1BVxQMDHC7DQto`) | 62.108.44.118 = 62.108.44.113 (dieselbe Maschine, Plesk) |
| Pfad | `/etc/dokploy/compose/lus-sds-yzt7mc/` | `/opt/hefte-digital/` (`code/` = Klon, `files/` = Daten, `.env` = Geheimnisse) |
| Compose | `docker-compose.dokploy.yml` | `docker-compose.tldhost.yml` |
| Deploy | `git push` → GitHub Actions → Dokploy | von Hand, siehe unten |

Beide betreiben denselben Stapel: Convex-Backend, Postgres, MinIO, Kachel-Gateway,
Import-Worker, Weboberfläche. Die Convex-Cloud wird nicht mehr gebraucht; das alte
Deployment `dev:doting-meadowlark-384` lebt noch und hält die früheren Daten.

**Nutzdaten** liegen in zwei Ordnern, die jedes Deployment überleben:
`<pfad>/files/postgres` und `<pfad>/files/minio`. Ihre Sicherung ist die Sicherung
der Anwendung. Es gibt noch keine.

---

## 2. Der Umzug: was noch fehlt

Auf 62.108.44.118 laufen alle sieben Behälter seit zwei Tagen (healthy). Die vier
Unterdomains sind in Plesk angelegt, `digital.lesenundschenken.de` hat ein
Zertifikat und zeigt die Plesk-Standardseite — **die Weiterleitung nach innen
fehlt**.

Entschieden ist: **zwei Adressen statt vier.**

```
digital.lesenundschenken.de/          → Oberfläche        127.0.0.1:8090
digital.lesenundschenken.de/convex/…  → Convex-Daten      127.0.0.1:3210  (WebSocket!)
digital.lesenundschenken.de/hooks/…   → Stripe/Shop       127.0.0.1:3211
digital.lesenundschenken.de/api/…     → Kachel-Gateway    (innerhalb von web)
medien.digital.lesenundschenken.de/   → MinIO             127.0.0.1:9002
```

`/api` ist bewusst nicht Convex: dort liegt schon das Kachel-Gateway. Die Medien
brauchen eine eigene Adresse, weil die vorsignierte Upload-Anfrage über den Pfad
unterschrieben wird — ein Präfix bräche die Signatur.

Zu tun:

1. `/var/www/vhosts/system/digital.lesenundschenken.de/conf/vhost_ssl.conf`
   schreiben. Vorbild steht auf demselben Server unter
   `/var/www/vhosts/system/kameraden.de/conf/vhost_ssl.conf` (ProxyPreserveHost,
   ACME-Pfade nie proxen, WebSocket über `RewriteCond %{HTTP:Upgrade}`).
   Danach `plesk sbin httpdmng --reconfigure-domain digital.lesenundschenken.de`.
2. Dasselbe für `medien.digital.lesenundschenken.de` → `127.0.0.1:9002`,
   danach Zertifikat holen (fehlt dort noch):
   `plesk bin extension --exec letsencrypt cli.php -d medien.digital.lesenundschenken.de -m chuk@chuk.dev`
3. Überflüssige Unterdomains entfernen:
   `plesk bin subdomain --remove api.digital -domain lesenundschenken.de` (ebenso `hooks.digital`).
4. Admin-Schlüssel erzeugen und in `/opt/hefte-digital/.env` eintragen:
   `cd /opt/hefte-digital/code && docker compose -f docker-compose.tldhost.yml --env-file ../.env exec convex-backend ./generate_admin_key.sh`
5. Echte Schlüssel in dieselbe `.env`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `SHOP_WEBHOOK_SECRET`. Liegen auf diesem Server beim Shop — **nicht auslesen**,
   der Auftraggeber trägt sie ein.
6. Neu hochfahren, dann trägt `convex-setup` alles ins Backend:
   `docker compose -f docker-compose.tldhost.yml --env-file ../.env up -d --build`
7. Funktionen ausliefern:
   `CONVEX_SELF_HOSTED_URL=https://digital.lesenundschenken.de/convex CONVEX_SELF_HOSTED_ADMIN_KEY=… npx convex deploy`
8. Erst wenn alles läuft: GitHub-Actions-Ziel von Dokploy auf diesen Server
   umstellen (SSH-Schlüssel als Secret, `git pull && docker compose up -d --build`).

---

## 3. Stripe

Testschlüssel, kein Livebetrieb. In Stripe hängen zwei Endpunkte:

* alt: `…convex.site/stripe/webhook` (Cloud, tot, als Rückweg stehengelassen)
* neu: `https://hooks.d.chuk.dev/stripe/webhook` (`we_1UIp57Rzq…`, 7 Ereignisse)

Nach dem Umzug muss ein dritter auf `https://digital.lesenundschenken.de/hooks/stripe/webhook`
zeigen. Jeder Endpunkt hat sein eigenes Signaturgeheimnis, das Stripe nur beim
Anlegen herausgibt. Das des zweiten liegt in `_scratch/stripe-webhook-secret.txt`
(nicht im Repo).

**Der Kaufweg ist nie durchgetestet worden** — Testkarte 4242…, Freischaltung
über den Webhook, Heft lesen. Das steht aus.

---

## 4. Hefte

| Heft | Ordner → hochgeladen | Seiten | Artikel |
|---|---|---|---|
| Schwerterträger 36 (Greim) | 1,4 GB → 89 MB | 49 | 8, freigegeben, veröffentlicht |
| ZUERST! 3/2026 | 1,5 GB → 169 MB | 81 | 74, zur Prüfung |
| DMZ 170 | — | — | **nicht importiert** |
| DMZ-Zeitgeschichte 80 | — | — | **nicht importiert** |

Die Ordner liegen auf dem USB-Stick `/media/user/45AB4BA0663B29E4`. Playwright
darf nur innerhalb des Projektordners lesen, deshalb vor dem Import kopieren:
`cp -r "/media/…/<heft>" _scratch/import/` und danach wieder löschen.

Ein vollständiger Durchgang Seite für Seite durch alle vier Hefte steht noch aus
— Artikelgrenzen, Bildzuordnung, Reihenfolge.

---

## 5. Was in dieser Sitzung gebaut wurde

* **Eine Story ist ein Artikel.** Der Satz wird direkt gelesen statt über
  Seitenbereiche geraten; Absätze trennen an `<Br/>`, ausgelagerte Initialen
  kommen zurück an ihren Absatz. Prüfwerkzeug ohne Server: `scripts/satz-lesen.py`.
* **Bildausschnitte aus `GraphicBounds`** statt Seitenausschnitt, Schmuckflächen
  (Klebezettel, Kalenderblatt) fliegen raus, Klickflächen wachsen nur bei Nähe
  zusammen, Einstieg in den Artikel an der angetippten Seite.
* **Kein OCR mehr.** Der Einzelpreis kommt aus dem Verlagsshop
  (`itemprop="price"`); Rangfolge Redaktion → Laden → Impressum, Knopf dafür in
  der Redaktion. Tesseract ist aus dem Abbild entfernt.
* **Import parallelisiert**: Hochladen läuft neben dem Rendern (`Ladeschlange`,
  vier gleichzeitig), zwei Umwandlungsfäden. Ordnererkennung nach Dateiart statt
  nach Ort, Seitenzahl aus dem Satz, kein Eingabefeld mehr.
* **Keine Browser-Dialoge**: eigener Dialog (`components/Frage.tsx`) an allen vier
  Stellen.

Vier Fehler, die nur im Betrieb auftraten: `.mjs` kam als `octet-stream` (der
Import stand still), `boto3` fehlte im Kachel-Gateway (Titelbild 500),
`minio/mc` gibt es auf Docker Hub nicht mehr (quay.io), Artikelbilder wurden auf
Spaltenbreite hochgezogen.

---

## 6. Offene Punkte im Tracker

`bd ready` zeigt sie. Die wichtigsten: Rezensionsraster ordnen Bilder unsicher zu,
Anzeigenseiten landen als Artikelbilder, ein erneuter Import verwirft Freigaben,
kurze Reste werden eigene Artikel.

---

## 7. Regeln, die hier gelten

* Antworten knapp, auf Deutsch.
* Commits als `chukfinley <77645077+chukfinley@users.noreply.github.com>`, ohne
  Session-Links oder Co-Authored-By.
* Nichts nach `/tmp` schreiben — `_scratch/` im Projekt benutzen.
* Passwörter in Bitwarden, nicht ins Repo. Die `.env` auf dem Verlagsserver ist
  die einzige Stelle für dessen Geheimnisse.
* Lokal wird nicht mehr entwickelt; gearbeitet wird gegen die ausgerollte Anlage.
