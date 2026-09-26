# Übergabe — Stand 26.09.2026 (abends)

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

## 2. Verlagsserver und Verkauf über den Shop (Stand 26.09.2026 abends)

**Die Anlage läuft auf https://lesen.lesenundschenken.de.** Medien liegen auf
`medien.lesen.lesenundschenken.de`. `digital.lesenundschenken.de` leitet per 301
dorthin. Die Apache-Direktiven stehen in `deploy/apache/`. Die Daten von
d.chuk.dev sind übernommen (2 Hefte, 130 Seiten, 82 Artikel, 588 Medienobjekte,
Konten). d.chuk.dev läuft noch als Rückweg.

```
lesen.lesenundschenken.de/          → Oberfläche        127.0.0.1:8090
lesen.lesenundschenken.de/convex/…  → Convex-Daten      127.0.0.1:3210  (WebSocket)
lesen.lesenundschenken.de/hooks/…   → HTTP-Routen       127.0.0.1:3211
lesen.lesenundschenken.de/api/…     → Kachel-Gateway    (innerhalb von web)
medien.lesen.lesenundschenken.de/   → MinIO             127.0.0.1:9002
```

**Entscheidung: Verkauf nur über den PrestaShop.** Der Leser hat keine eigene
Zahlung. Der Stripe-Checkout ist aus (`STRIPE_CHECKOUT_ENABLED`). Die Stripe-
Schlüssel in der `.env` bleiben leer.

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

**Auslieferung der Convex-Funktionen nur über den SSH-Tunnel.** Die CLI wirft
das Präfix `/convex` weg:

```
ssh -N -L 13210:127.0.0.1:3210 root@62.108.44.118 &
npx convex deploy -y --env-file _scratch/verlag-tunnel.env
```

Offen:

1. **Pflicht vor dem Livegang:** E-Mail-Bestätigung einschalten
   (`drm-viewer-pwe`). Ohne sie bekommt jeder, der sich mit einer fremden
   Adresse registriert, deren Käufe. Das braucht `RESEND_API_KEY`.
2. Testkauf mit echter Karte: Produkt 10778 „Testkauf Digital“ (1 €), danach
   erstatten. Die Schritte stehen in `../docs/digital-verkauf-shop.md`, Abschnitt 5.
3. Die Abo-Produkte 10780–10787 sind inaktiv. Die Digital-Preise sind
   Platzhalter. Umschalten der Knöpfe:
   `~/lusdigital-tools/abo_links_umschalten.php --schreiben`.
4. AGB und Datenschutz beschreiben noch Stripe (`drm-viewer-kym`).
5. GitHub Actions auf den Verlagsserver umstellen.

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
