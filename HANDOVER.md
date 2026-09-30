# Übergabe — Stand 30.09.2026

**Neu am 30.09.:** Heftimport auf dem Verlagsserver repariert (lief dort nie),
alle vier Hefte vom Stick importiert, Import schneller. Einzelheiten in
Abschnitt 1a und 4.

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
| Deploy | `git push` → GitHub Actions → Dokploy | von Hand, siehe Abschnitt 1b |

Beide betreiben denselben Stapel: Convex-Backend, Postgres, MinIO, Kachel-Gateway,
Import-Worker, Weboberfläche. Die Convex-Cloud wird nicht mehr gebraucht; das alte
Deployment `dev:doting-meadowlark-384` lebt noch und hält die früheren Daten.

**Nutzdaten** liegen in zwei Ordnern, die jedes Deployment überleben:
`<pfad>/files/postgres` und `<pfad>/files/minio`. Ihre Sicherung ist die Sicherung
der Anwendung. Es gibt noch keine.

---

## 1a. Heftimport: wie er zusammenhängt (Stand 30.09.2026)

Die Redaktion zieht den Heftordner aus der Druckvorstufe auf „Admin → Heftordner
einlesen“ (`web/src/admin/FolderImport.tsx`). Die schwere Arbeit macht der
**Browser**, der Server bekommt nur Fertiges:

1. `folderScan.ts` verteilt die Rollen nach Dateiart: Innenteil-PDF, Umschlag-PDF
   oder Titelbild (TIF/JPG neben dem PDF), IDML, Bilder aus `Links/`. PDFs im
   Bilderordner sind platzierte Anzeigen und werden übergangen.
2. `pageRender.ts` öffnet das Innenteil-PDF einmal (Preis aus dem Impressum,
   dann Seiten), rendert jede Seite mit pdf.js auf 2400 px, schneidet den
   Anschnitt nach dem Netzformat aus der IDML ab. Bis zu drei Seiten
   gleichzeitig (`RENDER_SPUREN`, je Spur ein eigenes pdf.js-Dokument).
3. Bilder aus `Links/` wandeln Web-Worker um (`convertClient.ts`, 2–3 Fäden,
   1600 px JPEG). Die Originale bleiben auf dem Rechner.
4. Jede Datei geht **direkt in MinIO**: `uploads.presignUpload` (Convex-Aktion,
   **ohne** `"use node"`, Signatur in `convex/s3Presign.ts`) gibt eine
   vorsignierte PUT-Adresse `https://lesen.lesenundschenken.de/medien/emag-media/…`.
   Apache nimmt `/medien` ab und reicht an MinIO (127.0.0.1:9002). Danach
   `assets.registerUpload`.
5. Seitenreihenfolge speichern, Auftrag `imports.enqueue` → der **Import-Worker**
   (`extract-service/worker.py`, Container `import-worker`) holt ihn über
   `http://convex-backend:3211`, liest IDML und Seiten aus MinIO (intern
   `http://minio:9000`), baut Artikel, Bilder, Inhaltsverzeichnis. Dauer ~15 s.
6. Artikel stehen danach auf „zur Prüfung“. Freigeben in der Redaktion.

**Warum der Import am 30.09. mit `{"detail":"Not Found"}` abbrach** — zwei Fehler
hintereinander, beide nur auf dem Verlagsserver:

* `presignUpload` war eine Node-Aktion. Node-Aktionen rufen für `ctx.runQuery`
  das Backend über `CONVEX_CLOUD_ORIGIN` **ohne** das Präfix `/convex` zurück
  (`POST https://lesen.lesenundschenken.de/api/actions/query`). Apache gab
  alles unter `/api` an die Oberfläche, deren nginx ans Kachel-Gateway
  (FastAPI) → 404 `{"detail":"Not Found"}`. Der erste Seiten-Upload scheiterte.
  Die zwei Hefte, die schon drin waren, kamen von d.chuk.dev herüber — auf dem
  Verlagsserver hatte der Import nie funktioniert.
* Danach scheiterte der Upload selbst: `medien.lesen.lesenundschenken.de` liegt
  zwei Ebenen tief. Seit Cloudflare davor steht (28.09.), deckt dessen
  Zertifikat nur `*.lesenundschenken.de` → `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`.

Behoben: Apache reicht jetzt alles unter `/api` außer den vier Pfaden des
Gateways (`/api/session`, `/api/health`, `/api/issue/`, `/api/asset/`) an Convex
— damit gehen **alle** Node-Aktionen und die CLI ohne Tunnel. `presignUpload`
braucht Node gar nicht mehr. Uploads gehen über `/medien/` auf demselben Namen
(kein CORS, Cloudflare-Zertifikat passt). `medien.lesen.lesenundschenken.de`
wird nicht mehr gebraucht.

Außerdem gefixt: Balken wird bei Abbruch rot und sagt „Abgebrochen bei …“
(vorher sah er aus, als liefe er noch); Balken zählt nur Abschnitte, die der
Ordner hat; Anzeigen-PDF aus `Links/` wurde bei DMZ 170 zum Umschlag; das
Kachel-Gateway merkte sich Seiten unter Heft+Seitennummer und zeigte nach einem
erneuten Import das alte Bild (jetzt Schlüssel = Speicherdatei, Auflösung 30 s).

## 1b. Ausrollen auf den Verlagsserver (von Hand)

```
# Convex-Funktionen — direkt, ohne Tunnel (seit 30.09.)
npx convex deploy -y --env-file _scratch/verlag-direkt.env
#   verlag-direkt.env: CONVEX_SELF_HOSTED_URL=https://lesen.lesenundschenken.de
#                      CONVEX_SELF_HOSTED_ADMIN_KEY=… (aus /opt/hefte-digital/.env)

# Oberfläche / Worker / Gateway: Dateien nach /opt/hefte-digital/code, dann bauen
rsync -R -a <geaenderte dateien> root@62.108.44.118:/opt/hefte-digital/code/
ssh root@62.108.44.118 'cd /opt/hefte-digital/code && \
  docker compose -f docker-compose.tldhost.yml --env-file /opt/hefte-digital/.env up -d --build web'

# Apache: deploy/apache/lesen.vhost_ssl.conf nach
#   /var/www/vhosts/system/lesen.lesenundschenken.de/conf/vhost_ssl.conf
#   plesk sbin httpdmng --reconfigure-domain lesen.lesenundschenken.de
```

Import von der Kommandozeile testen, wie ein Mensch über die Oberfläche:
`_scratch/import-test/import.mjs "<heftordner>"` (Playwright, Testkonto
`import-test@lesenundschenken.de`, Anmeldung über `magicLink:requestInternal`;
danach `account:purgeByEmailInternal`).

---

## 2. Verlagsserver und Verkauf über den Shop (Stand 26.09.2026 abends)

**Die Anlage läuft auf https://lesen.lesenundschenken.de**, vor ihr Cloudflare.
Medien liegen in MinIO, erreichbar unter `/medien/`. `digital.lesenundschenken.de` leitet per 301
dorthin. Die Apache-Direktiven stehen in `deploy/apache/`. Die Daten von
d.chuk.dev sind übernommen (2 Hefte, 130 Seiten, 82 Artikel, 588 Medienobjekte,
Konten). d.chuk.dev läuft noch als Rückweg.

```
lesen.lesenundschenken.de/          → Oberfläche        127.0.0.1:8090
lesen.lesenundschenken.de/convex/…  → Convex-Daten      127.0.0.1:3210  (WebSocket)
lesen.lesenundschenken.de/hooks/…   → HTTP-Routen       127.0.0.1:3211
lesen.lesenundschenken.de/medien/…  → MinIO             127.0.0.1:9002  (Präfix fällt weg)
lesen.lesenundschenken.de/api/session|health|issue/…|asset/…
                                    → Kachel-Gateway    (innerhalb von web)
lesen.lesenundschenken.de/api/…     → Convex            127.0.0.1:3210  (alles andere unter /api)
```

**Entscheidung: gebucht wird im PrestaShop.** Seit 29.09.2026 zahlt man im
Leser mit Karte (Abschnitt 3), die Bestellung entsteht trotzdem im Shop. Der
alte eigene Stripe-Checkout ist aus (`STRIPE_CHECKOUT_ENABLED`).

* **Redaktion → Shop:** In „Bearbeiten“ wählt die Redaktion das Druckheft aus
  dem Shop, mit einem Vorschlag. „Übernehmen“ holt Preis, Link und Cover.
  „Im Shop als E-Paper anbieten“ legt am Druckprodukt die Kombination
  „Ausgabe: Digital“ an (Shop-API im Modul `lusdigital`).
* **Shop → Leser:** Das Modul `lusdigital` meldet bezahlte und stornierte
  Bestellungen an `/hooks/shop/entitlements` (Vertrag v2). Die Freischaltung
  hängt an der E-Mail und greift auch, wenn sich der Kunde erst später anmeldet.
* Beide Richtungen sind signiert: `SHOP_WEBHOOK_SECRET` (Leser) =
  `LUSDIGITAL_SECRET` (Shop). Geprüft am 26.09.
* Vertrag: `docs/shop-integration.md`. Shop-Seite:
  `../docs/digital-verkauf-shop.md`.

**Auslieferung der Convex-Funktionen direkt** (seit 30.09., Abschnitt 1b). Der
SSH-Tunnel (`_scratch/verlag-tunnel.env`) geht weiterhin.

Offen:

1. ~~E-Mail-Bestätigung~~ erledigt am 29.09.2026: Anmeldung nur noch per
   E-Mail-Link (Abschnitt 2a). Wer sich anmeldet, hat die Adresse bewiesen.
2. Testkauf mit echter Karte: Produkt 10778 „Testkauf Digital“ (1 €), danach
   erstatten. Die Schritte stehen in `../docs/digital-verkauf-shop.md`, Abschnitt 5.
3. Die Abo-Produkte 10780–10787 sind inaktiv. Die Digital-Preise sind
   Platzhalter. Umschalten der Knöpfe:
   `~/lusdigital-tools/abo_links_umschalten.php --schreiben`.
4. AGB und Datenschutz beschreiben noch Stripe (`drm-viewer-kym`).
5. GitHub Actions auf den Verlagsserver umstellen.

---

## 2a. Anmeldung per E-Mail-Link (seit 29.09.2026)

**Keine Passwörter mehr.** Adresse eingeben → Mail → Link anklicken →
angemeldet. Anmelden und Registrieren sind derselbe Weg; das Konto entsteht
beim ersten Klick. Vertrag und Einzelheiten: `docs/shop-integration.md`,
Abschnitt „Anmeldung“.

* Mail verschickt der **Shop** (Shop-API `send_mail`, Vorlage im Modul
  `lusdigital`, Absender `bestellung-netzladen@`, DKIM von PrestaShop). Der
  Leser braucht keinen Mail-Schlüssel. Link 15 min, einmal, nur SHA-256
  gespeichert. Grenzen: 5 je Adresse/h (Leser und Shop), 20 je IP/h.
* Höchstens **zwei angemeldete Browser** je Konto (`MAX_LOGIN_SESSIONS`); die
  dritte Anmeldung beendet die älteste, der Browser meldet sich sofort ab.
  Lesesitzungen hängen an der Anmeldung. Kontoseite: Liste mit „Abmelden“.
* Bestehende Konten behalten Id, Rollen, Käufe (Suche über `users.email`).
  Die alten `password`-Konten liegen noch in `authAccounts`, können aber nicht
  mehr anmelden. `/claim/<token>` → `/login`; offene Gastkauf-Links werden
  beim Anmelden eingelöst.
* Code: `convex/magicLink.ts`, `magicLinkRules.ts`, `sessions.ts`, `auth.ts`;
  Oberfläche `web/src/components/MagicLinkForm.tsx` (`next?`),
  `pages/LoginPage.tsx`, `pages/LinkLoginPage.tsx` (`/anmelden`).
* Konto samt Shop-Freischaltungen einer Adresse löschen (Tests,
  Löschanfragen): `npx convex run account:purgeByEmailInternal '{"email":"…"}'`.
* Geprüft am 29.09.2026 im echten Betrieb (Testpostfächer auf dem Plesk,
  danach gelöscht): Mail kommt an mit `dkim=pass`, `dmarc=pass`; Link meldet
  an und führt auf `next`; zweiter Klick „schon benutzt“; Link nach 15 min
  „abgelaufen“; drei Browser nacheinander → der erste ist sofort abgemeldet
  (Hinweis ohne Neuladen), zweiter und dritter bleiben; Abmelden eines
  Browsers über die Kontoseite; Bestandskonto (altes Passwortkonto mit
  Shop-Kauf) behält Id und Heft. Skript: `_scratch/magiclink/e2e.mjs`.

## 3. Stripe: Kartenkauf im Leser (seit 29.09.2026 live)

Leser zahlen mit Karte direkt im Leser (Payment Element, gespeicherte Karte,
ein Klick), gebucht wird im Shop als Bestellung „Stripe (Leser)“, frei
geschaltet über den bestehenden grant-Weg. Beschreibung, Testprotokoll und
Schritte für den ersten Livekauf: `docs/shop-integration.md`, Abschnitt
„Kartenkauf im Leser“.

* Stripe-Konto des Shops. Convex-Umgebung: `LESER_STRIPE_MODE` (live),
  `LESER_STRIPE_SECRET_KEY_TEST|_LIVE`, `LESER_STRIPE_PUBLISHABLE_KEY_TEST|_LIVE`,
  `LESER_STRIPE_WEBHOOK_SECRET_TEST|_LIVE`. Nicht in der `.env`, nicht im Repo.
* Webhook-Endpunkte `we_1UL6eY…` (test) und `we_1UL6tJ…` (live) auf
  `https://lesen.lesenundschenken.de/hooks/stripe/webhook`.
* Apple Pay / Google Pay: Domain `lesen.lesenundschenken.de` in Stripe
  registriert (test und live aktiv); die Apple-Datei liefert `web/public`,
  Apache reicht sie durch (`deploy/apache/lesen.vhost_ssl.conf`).
* ~~Node-Aktionen gehen auf dem Verlagsserver nicht~~ — seit 30.09. behoben
  (Abschnitt 1a). Früher: (Rückruf ohne
  `/convex`-Präfix, Tracker). Neue Aktionen ohne `"use node"` schreiben.
* Der alte eigene Checkout (`billing.ts`, `STRIPE_CHECKOUT_ENABLED`, Test-
  schlüssel eines anderen Kontos) ist aus; sein Webhook liegt unter
  `/stripe/checkout-alt/webhook`.

## 4. Hefte

| Heft | Ordner → hochgeladen | Seiten | Artikel | Import 30.09. |
|---|---|---|---|---|
| Schwerterträger 36 (Greim) | 1,4 GB → 89 MB | 49 | 7, freigegeben, veröffentlicht, Tabelle S. 33 | 117 s |
| ZUERST! 3/2026 | 1,5 GB → 169 MB | 81 | 74, zur Prüfung | 147 s |
| DMZ 170 | 2,1 GB → 169 MB | 81 | 56, zur Prüfung | 162 s |
| DMZ-Zeitgeschichte 80 | 2,1 GB → 127 MB | 65 | 37, zur Prüfung | 140 s |

Alle vier am 30.09. vom Stick über die Oberfläche neu importiert (Greim und
ZUERST ersetzt, Greim danach mit `devtools:releaseIssueInternal` wieder
freigegeben). Sicherung davor: `_scratch/sicherung/vor-reimport-2026-09-30.zip`
(`npx convex export`, nur Tabellen). Im Leser geprüft: alle vier öffnen mit
richtigem Titel, Kacheln ohne Fehler.

Import-Zeiten gemessen mit Uplink ~5–10 Mbit/s: das Rendern ist mit drei
Spuren nicht mehr der Engpass, die Leitung ist es. Die Bilder aus `Links/`
wandelt der Browser jetzt wirklich parallel (vorher wartete die Schleife je
Bild, DMZ 170: 90 s → 53 s).

Die Ordner liegen auf dem USB-Stick `/media/user/45AB4BA0663B29E4`. Das
Skript `_scratch/import-test/import.mjs` liest direkt vom Stick (eigenes
Playwright, nicht das MCP, das nur im Projektordner lesen darf).

Ein vollständiger Durchgang Seite für Seite durch alle vier Hefte steht noch aus
— Artikelgrenzen, Bildzuordnung, Reihenfolge.

## 4a. Tabellen aus dem Satz (seit 29.09.2026)

Eine `<Table>` der IDML wird ein Artikelblock `type: "table"` mit
`articleBlocks.table` (Zeilen, Zellen, `headerRows`, `rowSpan`/`colSpan`,
`emphasis`), an ihrer Stelle im Textfluss. `text` traegt den flachen Text
fuer die Suche. Die Zellen kommen nicht mehr als lose Absaetze. Ohne
ausgewiesene Kopfzeile gilt eine eingefaerbte oder fette erste Zeile als
Kopf. Steht eine Tabelle allein auf einer Seite, geht sie in den Artikel der
Nachbarseite auf. Leser: `components/ArtikelTabelle.tsx` (echte `<table>`,
rollt auf dem Telefon seitlich); die Pruefansicht zeigt dieselbe Tabelle,
als Text bearbeiten laesst sie sich nicht.

* Nur Greim hat Tabellen: S. 33 (gedruckt) und eine zweite (16 Zeilen,
  Todesarten) auf der ungenutzten Musterseite „B" — nicht gedruckt, nicht
  uebernommen. ZUERST! 3/2026, DMZ 170, DMZ-Zeitgeschichte 80: keine.
* Greim live ohne Neuimport nachgezogen: `scripts/tabellen-aus-satz.py <idml>
  --seitenversatz 1 --json …` erzeugt den Block,
  `npx convex run tabellen:einsetzenInternal` setzt ihn ein (mit
  `probelauf: true` vorher pruefen). Der alte Zellen-„Artikel" Nr. 5 ist in
  „Pour le Mérite" aufgegangen (Bilder, Klickflaechen, Lesestand mit), sein
  Verzeichniseintrag entfernt. Alle anderen Artikel und Freigaben unveraendert;
  Nr. 6–8 heissen jetzt 5–7.
* Die gespeicherte IDML im Medienspeicher ist dieselbe wie auf dem Stick
  (ETag `195db0e9…`).

## 4b. Dasselbe Bild nur einmal je Artikel (seit 30.09.2026)

Zwei Ursachen, zwei Regeln im Import-Worker:

* **Schmuckrahmen um ein Foto** (`Bilderrahmen hoch.tif` u. ä., das Buchmodell
  unter einem Umschlag): ein Bildrahmen, in dem ein kleineres Bild liegt und
  ihn zu mindestens 60 % füllt, ist dessen Unterlage und fällt weg
  (`ohne_unterlagen` in `extractor/idml_articles.py`). Die Bildunterschrift
  hängt danach am Foto.
* **Dasselbe Bild mehrfach** (Aufmacher über die Doppelseite, Buchtitel als
  Stapel, Rahmen doppelt im Satz): `_store_images` vergleicht die fertigen
  Bilder (`render.fingerprint`/`same_picture`) und legt je Artikel nur das
  erste ab. Gleiche Datei mit anderem Aufdruck (Kalenderblatt) bleibt.

Im Bestand betraf das 43 Bilder in 14 Artikeln: DMZ-Zeitgeschichte 80
(35 Rahmen, 6 Dubletten), Greim S. 14/15 und DMZ 170 S. 3 (je eine Dublette),
ZUERST! 3/2026 keine. Sie sind am 30.09. mit
`devtools:removeArticleImagesInternal` (kennt `probelauf`) entfernt, ohne
Neuimport: Freigaben unverändert, 26 Bildunterschriften vom Rahmen ans Foto
übernommen. Convex-Funktionen und `import-worker` sind auf dem Verlagsserver
ausgerollt, d.chuk.dev über den Push.

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
