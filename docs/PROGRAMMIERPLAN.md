# Programmierplan E-Magazin-Plattform

Verbindliche technische Spezifikation. Wird waehrend der Umsetzung fortgeschrieben.
Stand: 2026-09-20.

## 1. Projektziel und MVP-Abgrenzung

Eine Verlagsplattform, die digitale Zeitschriftenausgaben verkauft und online
lesbar macht. Zwei gleichwertige Lesemodi: originalgetreue Seite und responsiver
Artikel-Fliesstext. Die Redaktion laedt Druckdaten hoch, das System erzeugt
Artikelentwuerfe, die Redaktion korrigiert und gibt frei.

Im MVP enthalten: Konto und Rollen, Einzelkauf und Abo ueber Stripe, externe
Shop-Anbindung, Import von PDF und IDML, vorberechnete Seitenkacheln,
Seiten- und Artikelmodus, Inhaltsverzeichnis, Lesefortschritt, Volltextsuche,
Redaktionsansicht mit Bloecken und Regionen, Self-Hosting per Compose.

Nicht im MVP: siehe Abschnitt 16.

## 2. Bestandsaufnahme des Prototyps

Geprueft am tatsaechlichen Code, nicht an der Dokumentation.

| Bereich | Stand | Entscheidung |
|---|---|---|
| `web/` React+Vite+Router 7 | funktionsfaehig, Seiten- und Artikelansicht rudimentaer | bleibt, Reader wird neu strukturiert |
| `convex/` 24 Module, ~3100 Zeilen | Auth, Stripe-Component, Entitlements, Artikel, Importauftraege | bleibt, Schema wird auf v2 gehoben |
| `convex/schema.ts` `books` | zu grob fuer einen Verlag | ersetzt durch `publications`/`issues`/`issuePages` |
| `articles.text` als einzige Wahrheit | Split ueber Zeichenversatz, Regionen werden dupliziert | ersetzt durch `articleBlocks` + `articleRegions` |
| `tile-service` PyMuPDF, 6x6 on the fly | funktioniert, aber AGPL und rechnet bei jedem Aufruf | Rendern auf PDFium, Kacheln werden beim Import erzeugt |
| `extract-service` PyMuPDF-Heuristik | brauchbare Artikelerkennung, 57 Artikel am Testheft | Parser auf pdfplumber, Ergebnis auf kanonische Bloecke |
| `importJobs` + FastAPI BackgroundTasks | Auftrag ueberlebt keinen Neustart | persistente Warteschlange mit Lease und Worker |
| `ADMIN_EMAILS` | kein Rollenmodell | ersetzt durch `roles` auf dem Nutzer, E-Mail nur als Erstzugang |
| Convex Cloud (dev) | Betrieb | Produktionsmodus ist ausschliesslich self-hosted |
| DRM-Spielereien (DevTools-Raten, Decoys, Canvas) | teils schaedlich, hat den Reader weiss gemacht | auf wirksame Mittel reduziert |

Inkonsistenzen zwischen README und Code zum Startzeitpunkt: README beschrieb
noch den Einzelbuch-Reader; `docs/artikel-import.md` und `docs/selfhosting.md`
waren aktuell. Alle drei werden am Ende gegen den Code geprueft.

## 3. Architektur

```
Browser (React SPA)
  |
  |-- Convex (self-hosted): Konto, Rollen, Katalog, Entitlements, Commerce, Suche
  |
  |-- Tile-Gateway (FastAPI): prueft Lesesitzung, liefert Kacheln aus MinIO
  |
  +-- Extract-Worker (Python): holt Auftraege aus Convex, rendert Seiten,
      zerlegt PDF/IDML, legt Kacheln und Bilder in MinIO ab
```

Persistenz: Convex-Backend auf PostgreSQL, grosse Dateien in MinIO
(Bucket `emag-media`). Convex speichert nur Metadaten und Objektschluessel.

### Warum Convex und warum self-hosted

Convex liefert Datenbank, Serverfunktionen, Reaktivitaet, Dateiablage,
Volltextindex und Zeitplanung in einem Stueck; der Prototyp nutzt das bereits.
Self-hosted, weil die Auslieferung der Kacheln sonst am Datenvolumen der Cloud
haengt und weil Verlagsdaten im Haus bleiben sollen. Der Betrieb laeuft ueber
`docker-compose.selfhost.yml`.

## 4. Datenmodell (Schema v2)

Neue Tabellen in `convex/schema.ts`:

* `publications` — Titelreihe. `name`, `slug`, `description?`, `isActive`.
* `issues` — Ausgabe. `publicationId`, `title`, `slug`, `issueNumber?`,
  `publicationDate?`, `coverAssetKey?`, `pageCount`, `isPublished`,
  `includedInSubscription`, `externalSku?`, `priceCents`, `currency`,
  `stripePriceId?`, `stripeProductId?`.
* `assets` — Objektspeicher-Eintraege. `key`, `bucket`, `contentType`, `bytes`,
  `kind` (`source|page|tile|image|cover`), `issueId?`, `convexStorageId?`.
  `convexStorageId` ist der Uebergangsweg, solange kein S3 konfiguriert ist.
* `issueSources` — Quelldateien. `issueId`, `kind` (`pdf|idml|indd`),
  `role` (`inner|cover|supplemental|archive`), `assetId`, `filename`, `sortOrder`.
* `issuePages` — kanonische Leserreihenfolge. `issueId`, `index` (0-basiert),
  `printedLabel?`, `role`, `sourceAssetId`, `sourcePageIndex`, `width`, `height`,
  `tileManifestKey?`, `previewKey?`.
* `articles` — nur Metadaten. `issueId`, `order`, `title`, `subtitle?`,
  `author?`, `teaser?`, `source`, `status`, `confidence?`, `primaryPageIndex`,
  `searchText` (denormalisiert fuer die Suche).
* `articleBlocks` — Inhalt. `articleId`, `issueId`, `order`, `type`, `text`,
  `sourcePageIndex?`, `sourceStoryId?`, `sourceFrameId?`, `styleName?`,
  `confidence?`.
* `articleRegions` — Klickflaechen. `articleId`, `issueId`, `pageIndex`,
  `x0/y0/x1/y1` normiert, `kind`, `order?`.
* `articleAssets` — Bilder am Artikel. `articleId`, `assetId`, `order`,
  `caption?`, `sourcePageIndex?`.
* `tocEntries` — Inhaltsverzeichnis. `issueId`, `order`, `label`, `section?`,
  `pageIndex?`, `articleId?`, `level`.
* `entitlements` — auf `issueId` umgestellt, `source` um `external_shop`
  erweitert, `validFrom?`/`validUntil?`.
* `importJobs` — `issueId`, `kind`, `status`
  (`queued|claimed|running|review|done|error`), `progress`, `message?`,
  `attempts`, `leaseUntil?`, `workerId?`, `payload?`.
* `shopGrants` — Nachweis der externen Shop-Aufrufe, idempotent ueber
  `externalOrderId` + `action`.
* `auditLog` — `actorUserId?`, `action`, `target`, `detail?`, `createdAt`.
* `users` erhaelt `roles: string[]`.

Bestehende Tabellen `subscriptions`, `purchases`, `consents`, `claimTokens`,
`readingProgress`, `tileSessions`, `subscriptionPlans` bleiben, referenzieren
aber `issueId` statt `bookId`.

`books` bleibt nur bis zur Migration im Schema und wird danach entfernt.

## 5. Zugriffsmodell

Eine einzige Funktion `hasIssueAccess(ctx, userId, issueId)` in
`convex/access.ts`. Alle Leserpfade rufen sie auf: Artikel, Bloecke, Regionen,
Suche, Lesesitzung, Kachel-Gateway.

Regeln:

1. Entitlement mit `source=purchase|claim|admin|gift|external_shop` ohne
   `validUntil` gilt unbefristet, mit `validUntil` bis dahin.
2. Abo gilt, solange eine Zeile in `subscriptions` den Status
   `active|trialing|past_due` hat und `currentPeriodEnd` plus Kulanzfrist
   (Standard drei Tage) in der Zukunft liegt.
3. Ueber das Abo sind nur veroeffentlichte Ausgaben zugaenglich, die
   `includedInSubscription` nicht ausschliessen. Einzelkauf gilt auch vor der
   Veroeffentlichung, etwa fuer Vorabexemplare.
4. Rueckerstattung und Chargeback entziehen das Kauf-Entitlement.

## 6. Objektspeicher

Bucket `emag-media`, Schluesselschema:

```
publications/<publicationId>/issues/<issueId>/sources/<assetId>.<ext>
publications/<publicationId>/issues/<issueId>/pages/<index>/full.jpg
publications/<publicationId>/issues/<issueId>/tiles/<index>/<z>/<x>_<y>.jpg
publications/<publicationId>/issues/<issueId>/images/<assetId>.jpg
publications/<publicationId>/issues/<issueId>/covers/<assetId>.jpg
```

Original-PDF und IDML sind nie oeffentlich. Der Browser bekommt ausschliesslich
Kacheln und Artikelbilder, und zwar ueber das Gateway mit Sitzungspruefung.

Ohne konfiguriertes S3 faellt das Storage-Modul auf die Convex-Dateiablage
zurueck, damit die Entwicklung ohne MinIO laeuft. Das Datenmodell aendert sich
dadurch nicht: `assets.key` bleibt die Adresse, `assets.convexStorageId` ist
nur der Ablageort.

## 7. Importpipeline

1. Redaktion legt Ausgabe an und laedt Quellen hoch (Innenteil-PDF,
   Umschlag-PDF, optional IDML, optional INDD als Archiv).
2. Wizard schlaegt die kanonische Seitenreihenfolge vor: Umschlag in
   Bogenreihenfolge wird zu U1, U2, Innenteil, U3, U4 sortiert. Der Vorschlag
   ist aenderbar, nichts ist hartcodiert.
3. Auftrag geht als `queued` in `importJobs`.
4. Worker holt den Auftrag mit Lease, rendert jede kanonische Seite mit PDFium,
   erzeugt Kachelpyramide, legt Vorschaubild und Cover an.
5. Textextraktion mit pdfplumber: Bloecke mit Position, Schrift, Groesse.
6. Optional IDML: Stories, Frames, Absatzformate.
7. Normalisierung beider Quellen auf `SourceBlock`.
8. Artikelaufbau aus Spaltenfolge, Schriftgroessen, Fortsetzungssignalen,
   optional LLM-Gruppierung.
9. Artikel, Bloecke, Regionen, Bilder und Inhaltsverzeichnis werden als
   Entwurf geschrieben, Auftrag geht auf `review`.

Keine automatische Veroeffentlichung.

## 8. Lizenzentscheidung PDF-Werkzeuge

PyMuPDF steht unter AGPL und ist fuer den proprietaeren Betrieb heikel.
Produktionspfad daher:

* Rendern: `pypdfium2` (PDFium, BSD/Apache).
* Text und Layout: `pdfplumber` und `pdfminer.six` (MIT).
* Bilder: Ausschnitt der gerenderten Seite statt Extraktion eingebetteter
  Bildobjekte; liefert auch bei Vektorgrafik ein brauchbares Bild.
* Kacheln: `pyvips`, falls libvips vorhanden, sonst Pillow.

PyMuPDF bleibt hoechstens als optionaler Entwicklungsweg und ist aus dem
Produktionspfad entfernt.

## 9. Reader

`web/src/reader/` mit `ReaderShell`, `PageMode`, `ArticleMode`, `ReaderRail`,
`TocDrawer`. Genau zwei Modi, jederzeit umschaltbar. Die untere Leiste zeigt im
Seitenmodus Seiten, im Artikelmodus Artikel. Inhaltsverzeichnis in beiden Modi
ueber denselben Knopf. Klick auf eine Artikelregion wechselt in den
Artikelmodus, Rueckwechsel springt auf `primaryPageIndex`.

Lesefortschritt speichert Modus, Seite und Artikel, gedrosselt geschrieben.

## 10. Kopierschutz

Wirksam: Originaldatei nie an den Browser, Zugriffspruefung serverseitig,
kurzlebige Lesesitzungen, Begrenzung gleichzeitiger Sitzungen, Ratenbegrenzung,
sichtbares Wasserzeichen mit Kontokennung im Reader, getrennte Dienstgeheimnisse.

Entfernt: DevTools-Erkennung ueber Fenstermasse, PrintScreen-Erkennung,
Canvas-Vergiftung, Koederanfragen, kuenstliche Verzoegerungen. Sie haben nichts
verhindert und den Reader zeitweise unbenutzbar gemacht.

## 11. Commerce und Shop-Anbindung

Stripe bleibt, gebuendelt in `convex/billing.ts` und `convex/stripeEvents.ts`.
Zusaetzlich `convex/shopIntegration.ts`: HMAC-signierte Server-Schnittstelle
unter `/shop/entitlements`, idempotent ueber `externalOrderId`, mit
Protokoll in `shopGrants` und `auditLog`. Ohne Konto wird ein Claim-Link
verschickt.

## 12. Rollen

`customer`, `editor`, `publisher`, `admin` in `users.roles`. Helfer
`requireRole`/`requireAnyRole` in `convex/roles.ts`. `ADMIN_EMAILS` gilt nur
noch fuer den ersten Admin.

## 13. Migration

`convex/migrations.ts` mit einer internen Mutation `migrateBooksToIssues`:
Standard-Publication anlegen, jedes `books`-Dokument zu einem `issue`,
Entitlements, Kaeufe, Lesefortschritt und Lesesitzungen umhaengen, Artikel in
`articles` plus je einen Paragraph-Block je Absatz ueberfuehren, `boxes` zu
`articleRegions`. Die Migration ist wiederholbar und protokolliert, was sie
getan hat.

## 14. Teststrategie

* Convex: Zugriffslogik, Artikeloperationen, Shop-Schnittstelle, Rollen.
* Python: Seitenreihenfolge, Textbereinigung, Artikelaufbau, IDML-Fixture.
* Ende zu Ende am echten Heft ZUERST! 3/2026.
* Typecheck und Build fuer Web und Convex, `docker compose config`.

## 15. Akzeptanzkriterien

Uebernommen aus dem Auftrag, Abschnitte 31 und 32. Geprueft wird am Testheft:
84 kanonische Seiten aus 80 plus 4, Kacheln fuer jede Seite, Artikel als
Entwurf, Korrektur ueber Merge/Split/Block-Verschieben, Reader mit beiden Modi.

## 16. Bewusst nicht im MVP

Native Apps, Offline, Widevine, INDD-Auswertung, Freigabe-Workflow,
Versionierung, Mandantenfaehigkeit, Empfehlungen, Annotationen, Vorlesen,
KI-Zusammenfassungen, zweiter Zahlungsanbieter, Keycloak, CMS-Migration,
Next.js, Redis oder Celery.

## 17. Erweiterungspunkte

* Weitere Analyzer (Docling, Adobe) hinter derselben `SourceBlock`-Grenze.
* S3 oder R2 statt MinIO ueber dieselbe Storage-Schnittstelle.
* OIDC-Anmeldung, sobald der Shop sie anbietet.
* Mehrere Abo-Plaene je Publication.
