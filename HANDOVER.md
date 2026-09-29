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

**Auslieferung der Convex-Funktionen nur über den SSH-Tunnel.** Die CLI wirft
das Präfix `/convex` weg:

```
ssh -N -L 13210:127.0.0.1:3210 root@62.108.44.118 &
npx convex deploy -y --env-file _scratch/verlag-tunnel.env
```

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
* **Node-Aktionen gehen auf dem Verlagsserver nicht** (Rückruf ohne
  `/convex`-Präfix, Tracker). Neue Aktionen ohne `"use node"` schreiben.
* Der alte eigene Checkout (`billing.ts`, `STRIPE_CHECKOUT_ENABLED`, Test-
  schlüssel eines anderen Kontos) ist aus; sein Webhook liegt unter
  `/stripe/checkout-alt/webhook`.

## 4. Hefte

| Heft | Ordner → hochgeladen | Seiten | Artikel |
|---|---|---|---|
| Schwerterträger 36 (Greim) | 1,4 GB → 89 MB | 49 | 7, freigegeben, veröffentlicht (Tabelle S. 33 seit 29.09.) |
| ZUERST! 3/2026 | 1,5 GB → 169 MB | 81 | 74, zur Prüfung |
| DMZ 170 | — | — | **nicht importiert** |
| DMZ-Zeitgeschichte 80 | — | — | **nicht importiert** |

Die Ordner liegen auf dem USB-Stick `/media/user/45AB4BA0663B29E4`. Playwright
darf nur innerhalb des Projektordners lesen, deshalb vor dem Import kopieren:
`cp -r "/media/…/<heft>" _scratch/import/` und danach wieder löschen.

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
