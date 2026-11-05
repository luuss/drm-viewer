# digital.weltkrieg-online.de — zweiter Leser (seit 03.11.2026)

Kopie von digital.lesenundschenken.de für die E-Books und Hefte von
weltkrieg-online.de (WooCommerce, Histomedia AG). **Gleicher Code, eigene
Anlage**: eigene Datenbank, eigene Dateien, eigene Geheimnisse, eigene Konten.
Was sich unterscheidet, steuert die Marke (`VITE_MARKE=weltkrieg`) und die
Umgebung der Anlage.

## Was wo läuft

| | |
|---|---|
| Adresse | https://digital.weltkrieg-online.de (kein Cloudflare, Let's Encrypt über Plesk) |
| Server | 62.108.44.118 (Plesk, derselbe wie digital.lesenundschenken.de) |
| Plesk | Subdomain `digital` von `weltkrieg-online.de`, Abo `freikorps.info`, Docroot leer |
| Apache | `deploy/apache/digital-weltkrieg.vhost_ssl.conf` → `/var/www/vhosts/system/digital.weltkrieg-online.de/conf/vhost_ssl.conf`, `vhost.conf` = nur CROWDSEC-Block, danach `plesk sbin httpdmng --reconfigure-domain digital.weltkrieg-online.de` |
| Pfad | `/opt/weltkrieg-digital/` — `code/` (Stand aus `git archive`, Commit in `code/STAND`), `files/postgres`, `files/minio`, `.env` |
| Compose | `docker-compose.weltkrieg.yml`, Projekt **`wkdigital`** |
| Ports (nur 127.0.0.1) | Convex 3220/3221, MinIO 9012, Oberfläche 8091, Konsole 6792 |
| Convex-Instanz | `wkdigital` |

Die Ports von digital.lesenundschenken.de (3210/3211/9002/8090/6791) bleiben
unberührt. Beide Stapel brauchen zusammen etwa 2 GB RAM.

## Geheimnisse

* `/opt/weltkrieg-digital/.env` — alle Zufallswerte, beim Anlegen auf dem
  Server erzeugt (nie ausgegeben). `ADMIN_EMAILS` ist von
  `/opt/hefte-digital/.env` übernommen.
* `/opt/weltkrieg-digital/admin-key.env` — nur `CONVEX_SELF_HOSTED_ADMIN_KEY`.
  Liegt getrennt, weil die `.env` nicht per `sed` geändert werden darf
  (Hook). Compose bekommt beide Dateien: `--env-file ../.env --env-file ../admin-key.env`.
* `/opt/weltkrieg-digital/convex-deploy.env` — URL `http://127.0.0.1:3220` +
  Admin-Schlüssel für `npx convex deploy|run` auf dem Server.
* WordPress-Option `wkdigital_secret` = `SHOP_WEBHOOK_SECRET` der Anlage.

## Ausrollen

Immer aus einem committeten und gepushten Stand von `claude/digital`:

```bash
# Code
git archive --format=tar HEAD | ssh root@62.108.44.118 \
  'cd /opt/weltkrieg-digital/code && tar xf - && echo <commit> > STAND'

# Oberfläche, Worker, Gateway
ssh root@62.108.44.118 'cd /opt/weltkrieg-digital/code && docker compose -p wkdigital \
  -f docker-compose.weltkrieg.yml --env-file ../.env --env-file ../admin-key.env up -d --build web'

# Convex-Funktionen: auf dem Server im Container (der Hook lässt lokal nur verlag-direkt.env zu)
ssh root@62.108.44.118 'docker run --rm --network host -v /opt/weltkrieg-digital/code:/app -w /app \
  --env-file /opt/weltkrieg-digital/convex-deploy.env node:22-alpine \
  sh -c "npm ci --no-audit --no-fund --ignore-scripts >/dev/null 2>&1; npx convex deploy -y"'

# Umgebungswerte nachtragen (nach Änderung in .env)
ssh root@62.108.44.118 'cd /opt/weltkrieg-digital/code && docker compose -p wkdigital \
  -f docker-compose.weltkrieg.yml --env-file ../.env --env-file ../admin-key.env up -d convex-setup'
```

`npx convex run …` geht genauso (statt `deploy`).

## Anmeldung und Mail

Anmeldung wie im Lesen-und-Schenken-Leser per E-Mail-Link. Den Link
verschickt **nicht** PrestaShop, sondern das mu-plugin
`deploy/weltkrieg/wk-digital.php` im WordPress von weltkrieg-online.de
(`wp-content/mu-plugins/wk-digital.php`, Besitzer `freikorps:psacln`):

* `POST https://weltkrieg-online.de/wp-json/wkdigital/v1/api`, gleicher
  Vertrag und gleiche Signatur wie `lusdigital` (HMAC-SHA256 im Header
  `x-shop-signature`, `ts` ±300 s). Leser: `SHOP_API_URL` zeigt dorthin.
* Bisher nur `send_mail` (Vorlage `lusdigital_login`, nur Links auf
  `https://digital.weltkrieg-online.de/`, 5 Mails je Adresse und Stunde).
  Alle anderen Aktionen antworten 501 `not_implemented`.
* Absender `Weltkrieg Digital <versand@weltkrieg-online.de>`, Envelope-From
  gleich (SPF `a` greift, DMARC `p=none`, kein DKIM für die Domain), über das
  lokale Postfix wie die WooCommerce-Mails.
* Geheimnis neu setzen (wp-cli braucht mehr Speicher, sonst „kritischer
  Fehler“ durch WooCommerce):
  `sudo -u freikorps /opt/plesk/php/8.3/bin/php -d memory_limit=1024M /usr/local/bin/wp option update wkdigital_secret "<wert>" --autoload=no`
* `HEFT_ANKUENDIGUNG=aus`: Mails zu neuen Heften kann das Plugin noch nicht.

Geprüft am 03.11.2026: Link angefordert an ein Testpostfach auf dem Server
(`digitaltest@weltkrieg-online.de`, danach gelöscht), Mail kam an (Spam-Score
0,0, Return-Path `versand@weltkrieg-online.de`), Link im Browser geöffnet →
angemeldet, „Mein Konto“ und „Abmelden“ sichtbar. Testkonto danach mit
`account:purgeByEmailInternal` gelöscht.

## Marke (Aussehen)

`VITE_MARKE=weltkrieg` beim Bau (Compose setzt es als Build-Argument):

* `web/src/lib/marke.ts`: Name, Logo, Laden, Kontakt (Histomedia AG), Fuss,
  Copyright, Rechtstexte, Kopfbild, Farbstreifen.
* `web/src/lib/reihen.ts`: Weltkrieg-Reihen (Originalband, Doppelband,
  Großband, Flieger, Marine, Soldaten, Magazin, Blitzkrieg, Freikorps,
  Legion) mit den Farben der Menüleiste von weltkrieg-online.de und Link auf
  deren Kategorie. Zugeordnet wird über den Reihennamen (Regex).
* `web/src/styles.css`, Block „MARKE WELTKRIEG“ am Ende: Domine/Playfair,
  Papiergrund, dunkle Knöpfe in Versalien, Fuss #222 mit Linie #0077c0.
* `web/vite.config.ts`: Titel, Favicon, `data-marke` im rohen HTML.
* Bilder `web/public/img/wk/`: Schriftzüge als SVG-Pfade aus Anton
  (`tools/marke/wk_schriftzuege.py`), Kopfbild als WebP mit Transparenz
  (das Flugzeug ragt unten heraus wie im Laden), Favicons aus dem Laden.
  Schriften `web/public/fonts/domine-*.woff2` (vom Laden, selbst gehostet).
* Ohne `VITE_MARKE` bleibt der Lesen-und-Schenken-Leser unverändert.

## Heftimport (geprüft 03.11.2026)

* Upload-Weg geht: vorsignierte Adresse (Signatur ohne `/medien`, wie
  `convex/s3Presign.ts`), `PUT https://digital.weltkrieg-online.de/medien/emag-media/…`
  → 200, Datei liegt in `files/minio/emag-media/`. Convex-Umgebung:
  `S3_ENDPOINT_URL=https://digital.weltkrieg-online.de/medien`.
* **Ohne IDML wird hier nur gewarnt, nicht gesperrt** (`IST_WELTKRIEG` in
  `web/src/admin/FolderImport.tsx`): es gibt Bände nur als PDF. Beim
  Lesen-und-Schenken-Leser hält der Import ohne IDML an.
* Laden-Abfragen (Buchanzeigen, Produktabgleich, Cover) laufen nach dem
  Import im Hintergrund und fangen `ShopApiError` ab; die 501 des mu-plugins
  brechen den Import nicht ab.
* Ordnername wie bei L&S: „Originalband 12“ → Reihe „Originalband“, Heft 12.
* Der Worker meldete beim ersten Start `404 … HTTP actions enabled`, weil die
  Convex-Funktionen noch nicht ausgerollt waren. Nach dem Deploy weg; nach
  einem Neuaufbau zuerst `npx convex deploy`, dann den Worker starten.

## Buch-Modus: ein Heft ist ein Text (03.11.2026)

* **Import:** `IMPORT_MODUS=buch` am Import-Worker (nur `docker-compose.weltkrieg.yml`),
  Code `extract-service/extractor/buch.py`. Die Absatzformate taugen bei
  Weltkrieg nicht: der ganze Fließtext steht im Format
  „weltkrieg kapitelüberschrift“, die Zeitschriften-Regeln hielten ihn für eine
  Überschrift und warfen ihn weg (Heft 159: 2 Artikel, 4.000 Zeichen statt
  212.000). Jetzt: alle Absätze in Seitenfolge, kleine Stories am Bild
  (Unterschrift, „Bildquelle: …“) raus, Fußnoten („* AOK = …“) an ihrer Seite,
  Kapitelzeile = kleine eigene Story in Kapitelform (doppelte Zeile = Kartentitel,
  raus), kleine Stories auf Seiten mit Anzeigenbild raus. Geprüft an 159 und 160.
  Prüfskript: `_scratch/wk160/probe.py <idml>` (aus `extract-service/`).
* **Leser:** „Leseansicht“ statt „Artikelansicht“. Der Regler zeigt in beiden
  Ansichten die Seiten; in der Leseansicht springt er im Text zur ersten Stelle
  der Seite. Die Seite oben im Text ist der Lesestand (`progress.save` mit
  `mode: article`, `pageIndex`) und wird beim Öffnen angesprungen
  (`IST_WELTKRIEG` in `ReaderShell.tsx`, `onSeite`/`sprungNr` in `ArticleMode.tsx`).
* **Titel und Reihe** kommen von der Titelseite (U1): Titel = größte Schrift
  unter dem Kopf (Schriftzug „WELTKRIEG“ steht oben), Reihe = Reihenname auf U1
  („erlebnisberichte – Doppelband“), Schreibung aus dem Satz
  (`web/src/admin/umschlagTitel.ts`). Das Kürzel hinter der Nummer („159d“,
  d = Doppelband, mag, F, FK, FL …) ist **kein** Beleg für die Reihe (Anweisung
  03.11.), es fällt nur aus dem Titel.
* **Ordnerstruktur einlesen:** zweites Feld im Admin; lädt nur die Liste
  (Pfad, Größe, Datum) nach `emag-media/struktur/<zeit>-<name>.json`. Holen:
  im Container `wkdigital-import-worker-1` mit boto3 (wie die IDML in
  `_scratch/wk160`). Zweck: Musterhefte je Reihe aussuchen, dann Massenimport.

## Heftarchiv und Massenimport (03.11.2026)

* **Archiv** (Ordner `weltkrieg`, 309 GB, 67.288 Dateien; Liste in
  `_scratch/wk-struktur/liste.json`, nicht im Repo): je Reihe ein Ordner
  (Doppelbände, Fliegerhefte, Freikorps, Fremdenlegion, Großbände,
  Magazinhefte, Marinehefte, Normalhefte, Soldaten-Reihe), darin Nummernbereiche
  und je Heft `Ausgabe/` mit Innenteil- und Umschlag-PDF. Dazu
  `FÜR E-BOOKS/E-Books zum Veröffentlichen` (89 Hefte mit IDML+PDF, für epuboo).
  235 der 309 GB sind TIF.
* **Bestand:** 448 Hefte mit Innenteil: 316 nur PDF (+INDD), 97 PDF+IDML,
  15 nur INDD, 15 ohne alles, 5 nur PDF. **Der Import muss aus dem PDF
  allein laufen** (Anweisung 03.11.: keine IDML-Exporte von Hand).
* **Admin → „Hefte aus dem Heftarchiv importieren“**: ganzes Archiv
  hineinziehen; `web/src/admin/heftarchiv.ts` findet die Hefte (452 im Archiv,
  0,3 s): Innenteil-Datei („innenteil“ im Datei- oder Ordnernamen), Heftordner
  = oberster Ordner mit derselben Nummer (nicht „121-130d“), Fassung mit IDML
  vor nur PDF, „ALT-ALT“/„alte versionen“ raus. Erst nur `MUSTERHEFTE` (27).
  Hochgeladen werden nur die Bilder, die die IDML verlinkt; ohne IDML keine.
* **Text ohne IDML:** `extract-service/extractor/buch_pdf.py` aus der
  Textebene (`textebene.json`): Kolumnentitel/Seitenzahl am Kopf/Fuss raus,
  zweispaltig (Normalhefte, Doppelbände) und einspaltig, Initiale an die Zeile
  daneben, Absatz bei Einzug nach voller Zeile/Satzende, bei Abstand oder kurzer
  Zeile mit Satzende; Trennung auch ohne Strich in der Textebene (Zeile endet
  eine Strichbreite vor dem Rand); Fussnoten (klein, „*“) hinter den Absatz mit
  dem letzten Text ihrer Seite; Werbeseiten (≥5 grosse Zeilen) raus. Geprüft:
  284n (2-spaltig), 121d, 81mag. Prüfskript `_scratch/wk-pdf/probe2.py <textebene>`.
  Ohne Lesetext endet der Auftrag als Fehler.
* **Umschlag:** Die Umschlag-PDFs kommen in wechselnder Seitenfolge. Die
  Titelseite ist die Tafel mit der **eigenen Heftnummer** („Nr. 112“) plus
  Schriftzug/Preis (`titelseitenWert`, `tafelnNachInhalt` in `coverPages.ts`);
  Bogenpartnerin = U4, anderer Bogen = U2/U3. Anzeigen auf U3/U4 haben
  Schriftzug, „Nr.“ und Preis auch, aber nicht die eigene Nummer. Ohne
  Umschlag-PDF wird die Titelseite vorn im Innenteil gesucht.
* **Reihe Pflicht:** Erkennt die Titelseite keine Reihe, wird das Heft nicht
  importiert. Grund: am 03.11. schrieben sich 1d, 1n, 1g, 1m, 1fk und 1legion
  als „Weltkrieg 1“ ins selbe Heft. Freikorps und Blitzkrieg haben den
  Schriftzug als Bild; erkannt an „Erlebte Geschichte / Freiwillige
  Wehrverbände“ bzw. „Second World War in Fight“ (`umschlag` in `reihen.ts`).
  **Gesucht wird zuerst in der Zeile ganz oben** („erlebnisberichte –
  Grossband“), erst dann im Kopf und auf der Seite. Bis 05.11. im ganzen Kopf:
  „DOPPELSCHUSS ROT“ (Großband 147) wurde Doppelband und überschrieb das echte
  Doppelband 147, „Sturmsoldaten“ machte Freikorps 25 zu Soldaten 25.
* **Titel** (`umschlagTitel.ts`, neu 05.11.2026): Der Kopf (Schriftzug,
  Reihenzeile, Nr., Preis, www) wird **auf jeder Titelseite gemessen**, der
  Titel ist die grösste Schrift darunter samt direkt anschliessender Zeilen in
  etwas kleinerer Schrift (Dienstgrad über dem Namen). Schmale Reste am Bund
  („2o26“) zählen nicht, Stücke einer Zeile ohne Lücke sind ein Wort
  (Zierschrift „b|ombenk|R|ieg“). Schreibung **Wort für Wort aus dem Satz**
  (Innentitel, Kolumnentitel), Satzzeichen vom Umschlag; SS darf ß sein,
  Null im Wort ein O („R0T“), eine Trennung am Zeilenende entscheidet der Satz
  („Oberstleutnant“, aber „Rupel-Stellung“). Sonst `ausVersalien`.
  Bis 05.11. galt fest alles oberhalb von 22 % als Kopf: bei 49 Heften fehlte
  die erste Titelzeile („Stäbler“ Sander“ statt „„Generalstäbler“ Sander“).
* **Berichtigung 05.11.2026:** 112 Titel (fehlende Zeilen, Zierschrift-Reste,
  falsche Gross-/Kleinschreibung, Trennstriche) mit
  `devtools:titelBerichtigenInternal` (Titel, Text, Adresse; alte Adresse in
  `alteSlugs` führt weiter; je Aufruf höchstens ~15 Hefte, sonst
  Lesegrenze 16 MB). Großband 147 und Freikorps 25 mit
  `devtools:issueInReiheInternal` in ihre Reihe. **Offen:** Doppelband 147
  „Ausbruch aus Oserki“ neu importieren (Ordner
  `Doppelbände/141-150/147d …`, einzeln, die Massenliste hält ihn für fertig);
  Magazin 1–10 haben keinen Titel auf dem Umschlag („Weltkrieg 7“).
* **Prüfen nach jedem Import:** alle Titel gegen Titelseite und Satz und alle
  Reihen gegen die oberste Zeile vergleichen (Skripte 05.11. im Scratchpad:
  Textebenen holen, `nameVomUmschlag` mit esbuild bündeln, Liste der
  Abweichungen), nicht nur das Musterheft.
* Die 24 Testhefte vom 03.11. sind gelöscht (Liste `_scratch/wk-struktur/issues-vor-loeschen.json`),
  falsche Reihen „159d …“, „160d …“, „Weltkrieg“, „B“ abgeschaltet.
* Convex der Anlage von der Kommandozeile: `/root/wkrun [--identity JSON] fn JSON`
  auf dem Server, lokal `_scratch/wk-struktur/wkrun.sh`.

## Inhaltsverzeichnis: nur beim Magazin (05.11.2026)

Anweisung: im Leser immer ausblenden, außer bei den Magazin-Heften; dort soll
es wie bei digital.lesenundschenken.de funktionieren.

* **Befund** (alle 436 Hefte): jedes Heft hatte genau einen Eintrag, seinen
  Titel (der Import legt ohne erkanntes Verzeichnis je Artikel einen an, und
  im Buch-Modus gibt es nur einen). Nur das **WELTKRIEG-Magazin** druckt ein
  Verzeichnis: Seite „Inhaltsverzeichnis“ hinten im Heft (Leserseite 95–97),
  je Beitrag „Titel . . . Seite“, darüber Rubriken („Erlebnisbericht:“).
  Die Erzählhefte drucken keins; ihre großen Zeilen (Kapitelzeilen, Karten,
  Bildzeilen, Kolumnentitel „WELTKRIEG“) taugen nicht als Verzeichnis.
* **Import:** `extract-service/extractor/buch_verzeichnis.py` liest die
  gedruckte Seite aus der Textebene (Beleg: Stück „Inhalt“/„Inhaltsverzeichnis“
  + mindestens 3 Zeilen mit Seitenzahl am Rand). Ziel über `printedLabel`.
  Im Buch-Modus ersetzt es das Titel-Verzeichnis, die Zeilen der gedruckten
  Seite werden Klickflächen, und die Seite selbst ist kein Lesetext mehr
  (nur bei neuem Import). Über alle 436 Hefte gelaufen: greift in allen 44
  Magazin-Heften (712 Einträge), in keinem anderen. Tests:
  `extract-service/tests/test_buch_verzeichnis.py` (echte Seiten, auch die
  sechs Beinahe-Treffer aus Erzählheften).
* **Vorhandene Hefte:** Auftrag `toc` (`imports:enqueueInternal {issueId,
  kind:"toc"}`) liest im Buch-Modus nur das Verzeichnis neu und schickt
  `ersetzen: true` an `/service/jobs/toc-regions`; Text, Freigaben und
  Lesestände bleiben. Ohne gedrucktes Verzeichnis ändert er nichts.
* **Leser:** `verzeichnisZeigen` (web/src/reader): bei `IST_WELTKRIEG` Knopf
  und Leiste „Inhalt“ nur mit mindestens 2 Einträgen. Einträge führen dort
  immer über die Seite (`nachSeite` in `TocDrawer`), in der Leseansicht an die
  Stelle im Text wie der Regler (`seiteImText`); hervorgehoben ist der Eintrag
  der aufgeschlagenen Seite.
* Die Textebene verliert manche Bindestriche („Lockheed Martin F 35“,
  „Flugabwehrrakete IRIS T“); sie werden nicht dazuerfunden.
* **Nachgezogen am 05.11.2026:** `toc`-Auftrag für alle 44 Magazin-Hefte, 43
  mit allen Klickflächen. **Magazin 101** („Parole Grosser Zapfen-Streich“):
  der Lesetext reicht nur von Leserseite 2 bis 5 (alter Importfehler), daher
  hängen die 15 Einträge an keinem Text und haben keine Klickflächen; in der
  Seitenansicht führen sie zur Seite. Neu importieren und den Text prüfen.
* Die gedruckte Verzeichnisseite steht bei den 44 vorhandenen Heften noch im
  Lesetext (Punktleisten am Ende der Leseansicht); erst ein neuer Import
  (`full`) nimmt sie heraus.
* Geprüft live (Wegwerfkonto mit Rolle editor, danach gelöscht): Erzählheft
  ohne Knopf und Leiste (Desktop, Handy); Magazin 83 mit 16 Einträgen,
  Sprung in Seiten- und Leseansicht, Hervorhebung, Handy-Schublade.

## Kiosk und Erscheinungsdatum (05.11.2026)

* **Kiosk** (`web/src/library/KioskWeltkrieg.tsx`, nur bei `IST_WELTKRIEG`):
  die Hefte stehen gleich im Kiosk, nicht hinter Reihen-Kacheln. Umschalter
  oben rechts, Wahl in der Adresse (`?ansicht=`):
  * Kategorien (Standard): je Reihe eine Kachel, drei je Zeile, mit Schriftzug,
    neuestem Heft groß und vier weiteren daneben, Fuß „Zur Zeitschrift“.
  * Alle: jedes Heft in fünf Spalten, nach Erscheinungsdatum, Hefte ohne Datum hinten.
  * Neueste: das neueste Heft jeder Reihe.
  In einer Reihe gilt immer die Heftnummer (höchste = neueste). Keine
  Überschrift, nur Marke „Kiosk“ und Umschalter (Anweisung). Es erscheinen
  nur veröffentlichte Hefte (Anweisung: keine Vorschau für die Redaktion).
* **Erscheinungsdatum:** `tools/weltkrieg/erscheinung_aus_archiv.py <liste.json> <aus.json>`
  nimmt je Heft das früheste Dateidatum seiner Innenteil-PDFs in der
  Ordnerliste des Archivs (`emag-media/struktur/…-weltkrieg.json`), nur wo es
  zur Nummernfolge der Reihe passt. Gesetzt mit `devtools:erscheinungSetzenInternal`
  (nur Hefte ohne Datum, `probelauf`). Stand: 402 von 436 Hefte. Ohne Datum:
  29 frühe Hefte, die nur als neu exportierte E-Book-Fassung (Dateidatum 2026)
  im Archiv liegen (Originalband 2–14, Doppelband 2–8, Großband 1–5, Flieger
  2–8, Marine 1–4), und 5 ohne Innenteil-PDF (Soldaten 25, 56, Freikorps 1–3).
  Das Datum ist das der Herstellung, nicht des Kiosks; die Heftseite zeigt es
  als Monat und Jahr.
* Neu importierte Hefte bekommen kein Datum aus dem Archiv; im Kiosk stehen sie
  in ihrer Reihe nach Nummer, in „Alle“ hinten, bis das Werkzeug erneut läuft.

## Offen

* **Rechtstexte** (`drm-viewer-evz`): Impressum, Datenschutz, AGB, Widerruf
  verlinken auf die Seiten von weltkrieg-online.de. Die beschreiben den
  Laden, nicht Leser-Konto, Lesesitzungen und den Widerruf bei digitalen
  Inhalten (§ 356 Abs. 5 BGB). Bevor dort E-Books verkauft werden, eigene
  Texte für Histomedia AG nötig, sonst kann jeder Käufer nach dem Lesen
  widerrufen.
* **Freischaltung aus WooCommerce** (`drm-viewer-f4c`): Bestellungen müssen
  an `/hooks/shop/entitlements` gemeldet werden (grant/revoke, Vertrag v2,
  siehe `docs/shop-integration.md`). Kommt ins selbe mu-plugin.
* Kartenkauf im Leser ist aus (keine `LESER_STRIPE_*`-Werte).
* Admin-Bereiche sprechen noch vom „Netzladen“ mit PrestaShop-Funktionen
  (Druckheft suchen, E-Paper anbieten); die antworten hier 501.
* Sicherung von `files/` gibt es wie beim ersten Leser noch nicht.

## Lesen ohne Netz (seit 05.11.2026 geprueft)

Wie bei digital.lesenundschenken.de puffert der Leser das offene Heft
verschluesselt im Browser (HANDOVER Abschnitt 1g, `web/src/reader/puffer.ts`).
In der Leseansicht gilt dabei der Lesestand je Seite: wer ohne Netz neu
startet, steht an der zuletzt gelesenen Stelle im durchgehenden Text. Ein
Heft mit 68 Seiten sind gut 20 MB. Pruefen: `node _scratch/offline-puffer/pruefen-wk.mjs <ordner> [heftId]`
(Wegwerfkonto, veroeffentlicht nichts, loescht das Konto am Ende).
