# E-Magazin-Plattform

Verkauf und Online-Lesen digitaler Zeitschriften für einen Verlag. Kunden legen
ein Konto an, kaufen einzelne Hefte oder ein Abo und lesen die freigeschalteten
Ausgaben online — seitengetreu oder als responsiven Fließtext. Die Redaktion
lädt die Druckdaten hoch, das System erzeugt Artikelentwürfe, die Redaktion
prüft und gibt frei.

## Bestandteile

```
Browser (React + Vite)
   |
   |-- Konto, Katalog, Zugriffe, Commerce, Suche ---> Convex (selbst betrieben)
   |                                                    +-- PostgreSQL
   |                                                    +-- MinIO (Medien)
   |-- Seitenkacheln ------------------------------> Kachel-Gateway (FastAPI)
   |
   +-- (nur intern) Aufbereitung -----------------> Import-Worker (Python)
```

* **Convex**, selbst betrieben — Anmeldung, Rollen, Publikationen, Ausgaben,
  Seiten, Artikel, Entitlements, Stripe, Suche, Warteschlange.
* **Kachel-Gateway** — prüft die Lesesitzung und liefert Ausschnitte der beim
  Import gerenderten Seiten. Die Druckdatei verlässt den Server nie.
* **Import-Worker** — rendert Seiten mit PDFium, liest Text mit pdfplumber,
  wertet IDML aus, baut Artikel und aktiviert das Ergebnis in einem Zug.

Der Reader hat genau zwei Modi: **Seiten** und **Artikel**. Der Umschalter ist
immer erreichbar, die untere Leiste wechselt ihre Bedeutung mit, und das
Inhaltsverzeichnis liegt in beiden Modi auf demselben Knopf.

## Für Kundinnen und Kunden

Konto anlegen, Passwort zurücksetzen, Einzelheft oder Abo kaufen, Abo im
Stripe-Kundenportal selbst verwalten, lesen, suchen, Konto löschen.

Das Abo gilt je Titel und schaltet dauerhaft frei: alles, was während der
Laufzeit erscheint, plus das bei Abschluss aktuelle Heft. Eine Kündigung nimmt
nichts weg, eine Pause holt nichts nach.

## Für die Redaktion

Titel und Ausgaben anlegen, Quellen hochladen (Innenteil-PDF, Umschlag-PDF,
optional IDML, INDD als Archiv), Leserreihenfolge bestätigen, Aufbereitung
starten, Artikel prüfen (zusammenführen, an Blockgrenzen trennen, Blöcke
verschieben, freigeben oder ausschließen), Inhaltsverzeichnis pflegen, Ausgabe
veröffentlichen. Veröffentlichen geht erst, wenn jeder Artikel entschieden ist.

## Entwicklung

```bash
npm install
npx convex dev                                   # Backend
cd web && npm install && npm run dev             # Oberfläche auf 5173

cd tile-service   && uv venv && uv pip install -r ../requirements.txt
                     .venv/bin/python -m uvicorn main:app --port 8000
cd extract-service && uv venv && uv pip install -r requirements.txt
                     .venv/bin/python worker.py
```

Werte aus `.env.example` übernehmen. Geheimnisse gehören in die
Convex-Umgebung, nicht ins Repository.

Tests:

```bash
npm test                                   # Zugriff, Abo, Artikel, Shop-API
cd extract-service && .venv/bin/python -m pytest tests -q
```

## Selbst betreiben

`docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d`
startet Convex-Backend, PostgreSQL, MinIO, Kachel-Gateway, Import-Worker,
Oberfläche und TLS-Proxy. Vollständige Anleitung inklusive Referenzfall unter
eigener Subdomain: [docs/selfhosting.md](docs/selfhosting.md).

Convex Cloud ist für den Betrieb nicht vorgesehen.

## Dokumentation

| Datei | Inhalt |
|---|---|
| [docs/PROGRAMMIERPLAN.md](docs/PROGRAMMIERPLAN.md) | verbindliche technische Spezifikation |
| [docs/selfhosting.md](docs/selfhosting.md) | Betrieb, Umgebungswerte, Sicherung |
| [docs/artikel-import.md](docs/artikel-import.md) | Importweg, Grenzen der Automatik, Redaktion |
| [docs/shop-integration.md](docs/shop-integration.md) | Anbindung eines bestehenden Shops |

## Kopierschutz

Die Druckdatei geht nie an den Browser, jeder Lesezugriff läuft über eine
zentrale Prüfung, Lesesitzungen sind kurzlebig und je Konto auf zwei begrenzt,
Kachelabrufe sind gedrosselt, im Reader steht ein dezentes Wasserzeichen mit
der Kontokennung. Auf Spielereien wie Erkennung der Entwicklerwerkzeuge oder
Köderanfragen wird bewusst verzichtet: sie verhindern nichts und haben den
Reader zeitweise unbenutzbar gemacht.

## Rechtliches

Die Texte unter `/impressum`, `/agb`, `/widerruf` und `/datenschutz` enthalten
Platzhalter `[vom Verlag ausfüllen]`. Die müssen vor dem Start gefüllt werden.
Der Widerrufsverzicht wird im Bestellvorgang abgefragt und mit Wortlaut und
Version gespeichert.
