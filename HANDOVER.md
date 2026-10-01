# Übergabe — Stand 30.09.2026

**Neu am 30.09.:** Heftimport auf dem Verlagsserver repariert (lief dort nie),
alle vier Hefte vom Stick importiert, Import schneller. Einzelheiten in
Abschnitt 1a und 4. Buchanzeigen im Heft führen jetzt zum Produkt im Shop
(Abschnitt 4c). Randzungen, Zitatkästen und Seitenrubriken stehen nicht mehr
im Lesetext (Abschnitt 4d).

**Heftbezeichnungen (30.09. abends):** Frisch importierte Hefte standen unter
Ordnernamen im Kiosk („Dmz 170“ in der Reihe „Dmz“), weil der Ordner-Import
Reihen nach dem Kürzel im Ordnernamen anlegte und die Bezeichnungen aus dem
Laden erst der nächtliche Abgleich brachte. Jetzt: bekannte Reihen heißen wie
in `convex/shopCovers.ts` (`SERIES[].name`), `issues.ensureFromFolder` stößt
`publicationCovers.refreshAll` gleich nach dem Anlegen an, und der Abgleich
benennt Reihen um, die noch unter ihrem Kürzel stehen (samt Hefttiteln).

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

## 4c. Buchanzeigen führen in den Shop (seit 30.09.2026)

Anzeigen für eigene Bücher und Buchbesprechungen tragen im Artikel den Knopf
„Im Shop bestellen" (Produktseite, immer neuer Tab). Im Seitenmodus öffnet ein
Tipp auf die Anzeige die Auswahl „bestellen oder Text lesen". Fremdanzeigen
bleiben ohne Knopf. Regeln, Tabellen und Abläufe: `docs/shop-integration.md`,
Abschnitt „Buchanzeigen im Heft".

* Zuordnung nach jedem Import von selbst (`articleProducts:matchInternal`):
  zuerst über die Artikelnummer („Art. 101208" = Referenz im Shop), sonst über
  Titel, Verfasser und Preis. Verlinkt wird nur ein eindeutiger Treffer.
* Stand live: DMZ 170 9 Knöpfe, DMZ-Zeitgeschichte 80 16, ZUERST! 3/2026 6,
  Greim keine Anzeige; 30 Produkte. Sechs Anzeigen bleiben offen (Buch nicht
  im Shop, zwei Bände gleichen Namens und Preises, Titel nur im Bild); sie
  tragen den Knopf „Zum Shop" auf die Startseite des Shops.
* Redaktion → Artikel → „Produkte im Netzladen": entfernen, ergänzen,
  „Kein Knopf", „Automatik". Eine Entscheidung gilt auch nach einem neuen
  Import.
* Täglich 04:45 UTC Preise und Verfügbarkeit nachführen, offene Anzeigen der
  Hefte der letzten 60 Tage erneut versuchen.
* Geprüft im Betrieb am 30.09. (Wegwerfkonto, danach gelöscht), Rechner und
  Telefonbreite mit Berührung: Knopf im Artikel öffnet den Shop im neuen Tab,
  Auswahl im Seitenmodus, „Text lesen", Esc; Redaktionskasten und Suche.
* Offen: In den DMZ-Texten steht „t" statt „€" („Art. 102474 t 29,80"); die
  Preiserkennung kommt damit zurecht, der Lesetext zeigt es aber so.

## 4d. Randzungen und Seitenrubriken nicht im Lesetext (seit 30.09.2026)

Die Zunge am Seitenrand („Zungentext DMZ-Zeit 2018“: „Russische Panzerkorps /
schwer angeschlagen“), der Zitatkasten und die Rubrikmarke („Seitenrubrik“:
„Deutschland“, „Titel“) helfen auf der Druckseite beim Blättern. Der Import
hielt sie für kurzen Mengentext und hängte sie hinter den letzten Absatz ihrer
Seite — im Lesetext ein loser Halbsatz zwischen zwei Absätzen.

* Regel: `ROLLEN_REGELN` in `extractor/idml_articles.py`. Formate mit
  „zungentext“, „zitat“, „quote“ bekommen die Rolle `schmuckzitat`,
  „seitenrubrik“ ist `beiwerk`; beide kommen in keinen Artikel. Ein Zitat, das
  im Mengentext selbst steht, gehört zu dessen Story und bleibt. Ohne Satzdatei
  fällt weg, was das PDF als `quote` einstuft (`assemble`).
* Bestand ohne Neuimport bereinigt: `devtools:removeArticleBlocksInternal`
  (kennt `probelauf`; Reihenfolge bleibt lückenlos, Bildanker rücken nach,
  Suchtext neu, Shop-Verweise am Absatz fallen mit). Betroffen waren 74
  Absätze in 37 Artikeln: DMZ-Zeitgeschichte 80 37 Zungen, ZUERST! 3/2026 36
  Seitenrubriken, DMZ 170 ein Zitatkasten, Greim keiner. Freigaben, Bilder
  (539) und Shop-Knöpfe (37) unverändert. Welche Absätze es sind, rechnet
  `_scratch/randzitate/plan.py` aus der Satzdatei; die Zeilen vor der Änderung
  liegen in `_scratch/randzitate/live-vorher/`.
* Convex-Funktionen und `import-worker` sind auf dem Verlagsserver ausgerollt,
  d.chuk.dev über den Push.

## 4e. Inhaltsverzeichnis: Klickflächen auf den gedruckten Zeilen (seit 30.09.2026)

Die Links auf der Inhaltsseite (DMZ: Leseseite 2, DMZ-Zeitgeschichte: Seite 1
unter dem Editorial, ZUERST!: Seite 2) lagen übereinander und neben den
Einträgen. Der Satz kennt keine Zeilenpositionen; die Lage eines Absatzes im
Rahmen war nur nach Zeichenanteil geschätzt (`_verteile_auf_rahmen`).

* **Textebene als Quelle `text`.** Der Browser liest beim Rendern jeder
  Innenseite mit pdf.js die Textstücke samt Rechteck (`web/src/admin/textLayer.ts`,
  `pageRender.ts` mit `mitText`), normiert auf das Netzformat wie die
  Seitenbilder, und lädt sie als `textebene.json` hoch (rund 500 KB je Heft;
  `uploadRules.ts` erlaubt JSON). Die Druckdatei bleibt weiter auf dem Rechner.
* **Worker legt die Einträge auf die Zeilen** (`extractor/toc_layout.py`):
  Textstücke zu Zeilen und Spaltenstücken bündeln, je Eintrag die Titelzeilen
  (auch umbrochene), die gedruckte Seitenzahl daneben und die Unterzeile
  darunter suchen. Verglichen wird ohne Satzzeichen, Trennstriche und
  Ligaturen. Steht derselbe Eintrag zweimal (Spalte und Anreißer bei ZUERST!),
  gewinnt der Fundort, der dem Schätzwert am nächsten liegt. Ein nicht
  gefundener Eintrag verliert seine Fläche, statt auf dem Nachbarn zu liegen;
  `job.tocPlaced` im Worker-Log zeigt die Bilanz. Ohne Textebene bleibt der
  Schätzwert wie bisher.
* **Satz-Leser genauer** (`toc_from_idml`): ein Titel über zwei Absätze
  („Wahlrechtsentzug“ / „statt Strafpsychiatrie 23“) wird ein Eintrag,
  Rubrikzeilen mit Seitenzahl („Kalenderblatt Personen 16“) sind eigene
  Einträge, Rubrikzeilen ohne Zahl geben `section`, die Unterzeile bleibt als
  `details` am Eintrag.
* **Auftrag `toc`** (`imports.enqueue` mit `kind: "toc"`; Worker
  `_nur_verzeichnis`; Backend `activateTocRegionsInternal` über
  `/service/jobs/toc-regions`) ersetzt nur die Verzeichnisflächen
  (`articleRegions` mit `targetPageIndex`). Artikel, Freigaben und
  Verknüpfungen bleiben. Im Importdialog: „Textebene aus Innenteil (PDF)“
  liest die Textebene aus einem lokalen PDF (Netzformat aus der TrimBox der
  Datei) und stellt den Auftrag ein; „Inhaltsverzeichnis-Flächen neu legen“
  stellt ihn allein ein. **Achtung:** ein Worker ohne diesen Stand kennt die
  Auftragsart nicht und würde einen `toc`-Auftrag als vollen Lauf ausführen.
* **Abgesichert und automatisch.** Ein neuer Heftimport über „Heftordner
  einlesen“ lädt die Textebene immer mit hoch und legt die Flächen im selben
  Lauf; fehlt sie (Druckdatei mit Schriften in Pfaden), steht das in den
  offenen Punkten des Imports. Liegt statt der Textebene ein Innenteil-PDF
  am Heft (Importdialog), liest der Worker die Textebene selbst daraus
  (`text_items_from_pdf`). Die Auftragsmeldung am Heft („Bereit zur
  redaktionellen Prüfung · Inhaltsverzeichnis: alle 46 Einträge auf der Seite
  gefunden“ oder „… 3 ohne Klickfläche“, „… Flächen nur geschätzt“) zeigt der
  Redaktion die Bilanz; im Log heißt sie `job.tocPlaced`. Flächen, die sich
  trotz allem überschneiden, werden gezählt und gemeldet. Bei jedem Push
  laufen in CI die Regressionstests mit den echten Inhaltsseiten aller drei
  Reihen (`tests/fixtures/toc/*.json`, `test_toc_real.py`: jeder Eintrag
  gefunden, jede Fläche enthält Seitenzahl und Titelanfang, keine zwei Flächen
  übereinander) neben den Einzeltests (`test_toc_layout.py`, Convex
  `tocRegions.test.ts`, Browser `textLayer.test.ts`). Eine neue Reihe mit
  anderem Verzeichnislayout: Vorlage mit `_scratch/textebene/fixture.py`
  erzeugen und als vierten Fall eintragen.
* Ohne Oberfläche (Deploy-Schlüssel): `issueSources:addInternal`,
  `imports:enqueueInternal`; `_scratch/textebene/nachtragen.py <issueId>
  <textebene.json>` macht alle Schritte, `dump.mjs` erzeugt die Textebene mit
  pdf.js in Node (wie der Browser), `validate.py` zeichnet die Flächen auf das
  Seitenbild.
* Eng gesetzte Einträge untereinander teilen sich die Lücke: der Rand von
  drei Tausendsteln reichte sonst in den Nachbareintrag. Im Anreißer (ZUERST!)
  beginnt die Unterzeile bündig mit der großen Seitenzahl, nicht mit dem
  eingerückten Titel; die Zeilensuche kennt beide linken Kanten.
* **Bestand (alle drei Hefte mit Verzeichnis nachgetragen, Textebene aus den
  PDFs in `~/Schreibtisch/Kiel/`):** DMZ 170 25 Einträge, 25 Flächen;
  DMZ-Zeitgeschichte 80 15 Einträge, 15 Flächen (vorher 11; „DMZ Zeit 78
  innen.pdf“ ist das Innenteil der Nr. 80); ZUERST! 3/2026 46 Einträge, 45
  Flächen („Leserbriefe/Impressum 81“ hat keinen Artikel). Ein Eintrag, dessen
  Artikel erst auf der Folgeseite beginnt (Aufmacherseite mit Bild), führt zu
  diesem Artikel. Greim hat kein Inhaltsverzeichnis. Die Beschriftungen im
  Verzeichnis (Drawer) ändert der Auftrag nicht; die zusammengesetzten
  zweizeiligen Titel kommen erst mit einem neuen Import.

## 4f. Umschlag: U1 bis U4 im Reader, Anzeigen darauf anklickbar (seit 30.09.2026)

Vom Umschlag kam bisher nur die Titelseite als Bild in den Reader; U2, U3 und
U4 fehlten. Der Doppelseitenmodus paarte deshalb 3|4 statt U2|3, und die
Zählung in der unteren Leiste lief eins neben den gedruckten Seitenzahlen.

* **Import.** Liegt ein Umschlag-PDF im Heftordner, rendert der Browser es
  als einzelne Tafeln in Netzbreite (`web/src/admin/coverPages.ts`,
  `renderUmschlag` in `pageRender.ts`): zwei Bögen quer ergeben U4|U1 und
  U2|U3 — auch mit Rücken (Greim) oder Klappe (DMZ-Zeitgeschichte: drei Tafeln
  je Bogen, die Mitte gehört keiner Seite) —, vier Einzelseiten gelten als
  Bogenreihenfolge U4, U1, U2, U3 (ZUERST!), eine Einzelseite ist U1. Das
  Netzformat kommt aus der TrimBox der Datei. Die Leserreihenfolge nimmt die
  fertigen Tafeln (`buildPageOrder`, `coverReading`). Nur ein Titelbild (TIF)
  ohne Umschlag-PDF ergibt weiter allein U1.
* **Anzeigen auf U2 bis U4.** Je Tafel geht die Textebene als Quelle `text`
  mit Rolle `cover` hoch. Der Worker macht daraus je Tafel einen Artikel
  (`assemble_cover_pages`; Titel ist die größte Zeile mit Wörtern) mit
  ganzseitiger Klickfläche. Die Ladenzuordnung behandelt ihn wie jede Anzeige
  (`articleProducts:matchInternal`): mit Produkt im Laden fragt der Tipp
  „bestellen oder lesen“, sonst öffnet er den Anzeigentext. Die Titelseite
  bekommt keinen Artikel.
* **Abo-Aufrufe sind keine Artikel** (seit 30.09. abends). Wirbt eine Tafel
  (oder eine Anzeige im Innenteil bis 3000 Zeichen) mehrfach ums Abonnement,
  wird sie ein Seitenlink (`pageLinks`, Worker `_abo_links`,
  `extractor/abo.py`): im Seitenmodus öffnet ein Tipp darauf ohne
  Zwischenfrage das Abo-Formular der beworbenen Reihe im Laden, im neuen Tab.
  Welche Reihe: die Nennungen im Text; „DMZ Zeitgeschichte“ zählt nicht als
  DMZ, das Kombi-Abo mit der Schwester und die Verlagsanschrift nicht als
  Werbung, bei Gleichstand gilt die eigene Reihe; das Impressum ist kein
  Aufruf. Ziel je Reihe: `publications.shopPrintSubscriptionUrl` (Admin →
  „Abo-Formular Druckheft“), ohne Eintrag
  `lesenundschenken.de/module/luszeitformulare/formular?f=abo-<slug>`. Der
  Import ersetzt seine Links bei jedem Lauf; von der Redaktion angelegte
  (`source: editor`) bleiben. Bestand: sechs Links (ZUERST! wirbt auf U2 für
  sich, auf U3 für die DMZ; DMZ 170 auf U2 für sich, auf U3 für die
  Zeitgeschichte; Zeitgeschichte 80 und Greim auf U2 für sich), die sechs
  Anzeigen-Artikel dazu sind entfernt (`_scratch/umschlag/abo-links.py`).
* **Buchanzeigen auf dem Umschlag sind ebenfalls Seitenlinks** (seit 01.10.).
  Eine Tafel mit Preisen oder Bestellhinweisen (`extractor/anzeige.py`,
  `ist_anzeige`) wird kein Artikel: genau eine Artikelnummer → `shop` mit
  `reference` (Produktseite); eine Reihe mehrfach genannt oder neben einer
  Liste von Artikelnummern → `series` (Kategorie der Reihe,
  `shopCovers.SERIES`); sonst `shop` mit Suchbegriffen (`suchbegriffe`:
  mehrfach genannter Verfasser, Titelzeile, tragende Wörter) und `single`
  (ein Preis = ein Produkt). `pageLinks.resolveInternal` fragt nach jedem
  Import den Laden (`chooseTarget`): Einzelanzeige → Produktseite, wenn ein
  Begriff genau ein Produkt trifft; Sammelanzeige → Suchseite des Begriffs mit
  den meisten Treffern, ein mehrwortiger (Verfasser) ab drei Treffern zuerst.
  Ohne Antwort des Ladens später erneut; bis dahin und ohne Treffer gilt die
  Suchseite des ersten Begriffs. Eine Tafel ohne Preise (Greim U4, Orden des
  Greim) bleibt Artikel. Bestand: ZUERST! U4 → Produktseite „Zeugen deutscher
  Geschichte“; DMZ 170 U4 → Suche „Stefan Scheil“; DMZ-Zeitgeschichte 80
  U3/U4 → Suche „Geschichte Waffen-SS“; Greim U3 → Kategorie Schwerterträger
  (`_scratch/umschlag/umschlag-links.py`). Neu auflösen: `clearResolvedInternal`
  + `resolveInternal`; einzelne Felder: `setFieldsInternal`.
* **Der Tipp kommt über die Zeichenfläche.** OpenSeadragon bricht das
  Klick-Ereignis an der Zeichenfläche ab, bevor es bei React ankommt; die
  Knöpfe der Flächen (`.hotspot`) bekommen nie einen Klick. Der Treffertest in
  `PageMode` (`canvas-click`) ist der einzige Weg — er prüft Linkflächen vor
  Artikelflächen und öffnet den neuen Tab, mit Sperre gegen doppeltes Öffnen.
* **Bestand nachgerüstet** (`_scratch/umschlag/nachruesten.py <issueId>
  <umschlag.pdf> [--echt]`, Probelauf ohne `--echt`): `issuePages:insertInternal`
  fügt Seiten ein und rückt alles nach, was Seiten zählt — Artikel (Anfang,
  Ende, Hauptseite), Absätze, Klickflächen samt Sprungziel, Bildanker,
  Verzeichniseinträge, Lesestände. U1 ersetzt das Titelbild (2400 px statt
  1241 px). Ergebnis: DMZ 170 84 Seiten (1221 Datensätze nachgerückt),
  DMZ-Zeitgeschichte 80 68 (1044), ZUERST! 3/2026 84 (1695), Greim 36 52 (740);
  je Heft drei Anzeigen-Artikel, freigegeben (`articles:setReviewStatusInternal`).
  Die Umschlag-PDFs liegen in `~/Schreibtisch/Kiel/`.
* Reader: nichts geändert. Mit U2 an Stelle 1 stimmen Paare (U2|3, 4|5 …,
  82|U3, U4 allein) und Zähler („Seite 3“ ist die gedruckte 3, U2 zeigt „U2“).

## 4g. Stehende Rubriken: Titel und Verzeichnis (seit 01.10.2026)

Editorial, Impressum, Historischer Kalender, Leserbriefe, Buchbesprechungen
und die Kolumne haben im Satz meist keine Überschrift; als Artikel hießen sie
nach ihrer ersten Zeile („Verehrter Leser, 80 Jahre nach …“).

* `extractor/rubriken.py`: Das verlässliche Merkmal ist die **Kopfzeile der
  Seite** („Editorial“ oben auf der Seite): `kopfzeilen` liest sie aus der
  Textebene (oberste kurze Zeile im obersten Sechzehntel; die Satzdatei führt
  Kopfzeilen oft nur auf der Musterseite), `seitenrubriken` aus dem Satz, wo er
  sie hat. `titel_bereinigen`: erst ein Rubrikname oder Leserbrief-Bezug am
  Titelanfang („Impressum Deutsche …“ → Impressum, „Zu „…“ in DMZ 169“ →
  Leserbriefe), dann die Kopfzeile für das Hauptstück der Seite (den ersten
  Artikel darauf) ohne eigene Überschrift (`AssembledArticle.title_from_body`,
  gesetzt in `artikel_aus_satz`), dann der Eintrag des gedruckten
  Verzeichnisses („Claus-M. Wolfschlag: Die Kolumne“), zuletzt die Anrede
  („Verehrter Leser“) — auf die allein verlässt sich nichts. Je Seite bekommt
  eine Rubrik nur einen Artikel; drei Buchbesprechungen hießen sonst alle
  gleich. Rubriken: Editorial, Impressum, Historischer Kalender, Kalenderblatt,
  Leserbriefe, Buchbesprechungen, Nachruf, Politikmeldungen, Nachrichten,
  Meldungen, Kolumne, Vorschau, Zuletzt (`STEHENDE_RUBRIKEN`).
* `_build_toc_entries` legt für eine stehende Rubrik ohne Eintrag im
  gedruckten Verzeichnis einen Eintrag an (ohne Klickfläche, an ihrer Stelle
  in der Seitenfolge), außer die Seite oder die Folgeseite hat schon einen mit
  dem Namen („Leserbriefe/Impressum 81“).
* **Der Auftrag `toc` trägt jetzt auch Einträge nach**, die das gedruckte
  Verzeichnis nennt und das Heft noch nicht hat (Rubrikzeilen mit Seitenzahl,
  zweizeilige Titel). Ein kürzerer Eintrag derselben Seite wächst zum
  vollständigen Text („statt Strafpsychiatrie“ → „Wahlrechtsentzug statt
  Strafpsychiatrie“), statt sich zu verdoppeln; von der Redaktion bearbeitete
  Einträge bleiben, Löschungen auch (nur Fehlendes kommt dazu).
* Bestand: `_scratch/umschlag/titel.py` (Probelauf ohne `--echt`) hat 15 Titel
  berichtigt (Editorial ×3, Historischer Kalender, Die Kolumne, Buchbesprechungen
  ×3, Leserbriefe ×2, Nachruf, Impressum ×2 …) und Einträge ergänzt (Editorial in
  DMZ 170 und DMZ-Zeitgeschichte 80, Historischer Kalender, Buchbesprechungen).
  Der `toc`-Auftrag ergänzte 16 gedruckte Einträge (Kalenderblätter, Nachruf,
  Buchbesprechungen, volle zweizeilige Titel); ein Aufräumlauf verschmolz die
  dabei entstandenen Dubletten der alten Kurzfassungen. Stand: DMZ 170 27,
  DMZ-Zeitgeschichte 80 16, ZUERST! 41, Greim 7 Einträge. Werkzeuge:
  `articles:setTitleInternal`, `toc:insertInternal`, `toc:setLabelInternal`,
  `toc:removeInternal`.
* Offen: Buchbesprechungen und Leserbriefe nach dem ersten je Seite behalten
  ihre erste Zeile als Titel; bei der DMZ fehlt ihr dazu die Initiale
  („eltgeschichte ist Kriegsgeschichte“), siehe 5.

## 4h. Lesetext ohne Wiederholung des Kopfes (seit 01.10.2026)

Eine Überschrift, die der Setzer in zwei Absätze gebrochen hat („50 Prozent
der Russen“ / „sehen Deutschland als „Feind““), stand nach dem Titel noch
einmal im Lesetext — in 41 Artikeln. Dazu Unterzeilen und Vorspänne, deren
Wortlaut leicht vom Kopf abwich, und Kästen (Zitatkasten, „Klebezettel“), die
einen Satz des Artikels wiederholen.

* Worker `_ohne_kopfzeilen` (in `_build_payload`): Blöcke der Art
  Überschrift/Vorspann, deren Text in Titel, Unterzeile oder Vorspann
  enthalten ist, und Kästen, deren Text im Fließtext steht, kommen nicht in
  den Lesetext. Die Rohblöcke bleiben in der Debugansicht.
* Bestand bereinigt mit `devtools:removeArticleBlocksInternal` (Probelauf,
  dann echt): 171 Blöcke in 60 Artikeln (ZUERST! 120, DMZ-Zeitgeschichte 22,
  DMZ 170 17, Greim 12); Reihenfolge lückenlos, kein Bildanker verschoben.
  Plan in `_scratch/umschlag/dopplungen.json`. Nicht angefasst: die
  wiederholten Bezugszeilen der ZUERST-Leserbriefe („Zu „…“ in ZUERST!
  2/2026“ steht vor jedem Brief zum selben Artikel) — das ist der Druck.

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
