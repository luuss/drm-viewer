# DRM Reader (Convex + Stripe)

Standalone Web-App. Nutzer legen Account an, kaufen Bücher via Stripe, bekommen per E-Mail einen einmaligen Claim-Link und lesen via DRM-Tile-Reader. Kein Shopsystem dahinter.

## Architektur

```
 Browser (React SPA, Nginx)
    │
    ├── Auth / DB / Storage / Stripe-Webhook / Email  ──► Convex (cloud)
    │
    └── Tile-Requests  ──► FastAPI Tile-Service (Docker)
                              │
                              └─► holt PDF aus Convex Storage (signed URL)
```

- **Convex** — Auth (Passwort), DB (`books`, `entitlements`, `claimTokens`, `readingProgress`, `purchases`, `tileSessions`), Storage (PDF + Cover), Stripe-Checkout + Webhook, Resend-E-Mail.
- **Tile-Service (FastAPI + PyMuPDF)** — stateless. Validiert Session-Token via Convex, holt PDF aus Storage, rendert Tiles on-the-fly mit per-Session Zufallsvarianz (Sub-Pixel-Jitter, Zoom-Jitter, Pixel-Watermark). Zwei Renderings sind nie bytegleich.
- **Web (React + Vite)** — Login, Shop, Buch-Detail mit Stripe-Checkout, Claim-Seite, Library, Reader (6×6 Tile-Grid, Canvas-Poisoning, Noise-Overlay, DevTools-Guard etc.).

## Verzeichnisstruktur

```
drm-demo/
├── convex/             # Convex Backend (Schema, Queries, Mutations, Actions, HTTP)
├── tile-service/       # FastAPI + PyMuPDF (Docker)
├── web/                # React/Vite Frontend (Docker)
├── docker-compose.yml
└── .env.example
```

## Setup

### 1. Convex

```bash
cd convex
npm install
npx convex dev
```

Beim ersten Start legt Convex ein Deployment an und liefert die `CONVEX_URL`. Schreib sie in `.env`.

**Env-Variablen in Convex setzen** (Dashboard → Settings → Environment):

| Variable | Zweck |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Secret Key (sk_test_... oder sk_live_...) |
| `STRIPE_WEBHOOK_SECRET` | aus Stripe Dashboard, Webhook-Endpoint |
| `RESEND_API_KEY` | Resend API-Key (optional — ohne wird E-Mail nur in die Convex-Logs geschrieben) |
| `RESEND_FROM_EMAIL` | z.B. `DRM Reader <noreply@deinedomain.de>` |
| `APP_PUBLIC_URL` | öffentliche Frontend-URL, z.B. `https://reader.deinedomain.de` |
| `TILE_SERVICE_SECRET` | zufälliger langer String — muss mit dem der FastAPI-Umgebung übereinstimmen |

### 2. Stripe-Webhook

Stripe-Dashboard → Developers → Webhooks → "+ Add endpoint":

- URL: `https://<dein-convex-deployment>.convex.site/stripe/webhook`
- Events: `checkout.session.completed`

Den Signing-Secret in `STRIPE_WEBHOOK_SECRET` eintragen.

### 3. Tile-Service

```bash
cp .env.example .env
# CONVEX_URL, TILE_SERVICE_SECRET befüllen
docker compose up --build tile-service
```

Lokal ohne Docker:

```bash
cd tile-service
pip install fastapi "uvicorn[standard]" httpx pymupdf
export CONVEX_URL=https://... TILE_SERVICE_SECRET=...
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 4. Frontend (Dev)

```bash
cd web
npm install
cp .env.example .env
# VITE_CONVEX_URL, VITE_TILE_SERVICE_URL
npm run dev
```

### 5. Frontend (Docker)

```bash
docker compose up --build web
```

## Bücher anlegen

1. Einloggen.
2. `/admin` aufrufen (jede:r eingeloggte:r User hat derzeit Admin-Zugriff — in Produktion per Rollen-Check einschränken, siehe `convex/books.ts:createBook`).
3. Titel, Preis, Seitenzahl, PDF (+ optional Cover) hochladen.

Das PDF wird direkt in den Convex Storage geladen. Der Tile-Service holt es beim ersten Zugriff und cacht es In-Memory (LRU, 8 Bücher).

## Flows

### Kauf (eingeloggt)

1. User klickt "Kaufen" → `stripe.createCheckoutSession` Action → Stripe Checkout.
2. Zahlung erfolgreich → Stripe ruft `/stripe/webhook` auf.
3. Webhook-Handler erstellt `entitlement` + `purchase`, generiert `claimToken`, schickt E-Mail mit `/claim/<token>`.
4. User landet auf `/checkout/success` → Library lädt das Buch reaktiv.

### Kauf (Gast) oder geteilter Link

- Webhook erstellt `claimToken`, kein Entitlement (kein User).
- E-Mail-Link → Claim-Page zeigt Login/Signup.
- Nach Login wird `claims:claim` aufgerufen → erstellt Entitlement, bindet Token an User, markiert Token als eingelöst.
- **Geteilte Claim-Links sind nach dem ersten Einlösen tot.**

### Reader-Session

1. Reader-Seite ruft `tileSessions:issue({bookId})` — prüft Entitlement, gibt Session-Token (6h TTL).
2. Frontend schickt jeden Tile-Request mit `X-Tile-Session: <token>`.
3. Tile-Service ruft `tileSessions:verify` bei Convex.
4. Tile-Service rendert Tile mit per-Session-Randomisierung.

## DRM-Maßnahmen

### Server

- PDFs sind in Convex Storage, nur via kurzlebige signed URLs abrufbar — und nur vom Tile-Service (via `TILE_SERVICE_SECRET`).
- Tiles werden als 6×6 Grid (36 Tiles/Seite) gerendert.
- Einmal-Tokens pro Tile, 5min TTL.
- 10 Decoy-Requests pro Seite.
- **On-the-fly Variance** pro Request: sub-pixel Crop-Jitter, minimale Zoom-Variation, 24 zufällige ±1 Pixel-Flips. Kein Tile wird zweimal identisch ausgeliefert.

### Client

- Canvas-Methoden vergiftet (`toDataURL`, `toBlob`, `getImageData`, WebGL `readPixels` → leere Daten für Tile-Canvases).
- Pro Lesesession zusätzlicher deterministischer Pixel-Watermark.
- Noise-Overlay alle 1,5s neu.
- Shuffled DOM- und Fetch-Reihenfolge mit Zufalls-Delays.
- Rechtsklick/Drag/Keyboard-Shortcuts (Ctrl+S/P/U, F12, DevTools-Kombis) blockiert.
- DevTools-Heuristik (Fenstergrößen-Diff) → löscht Tiles.
- PrintScreen → löscht Tiles, rendert neu.
- Tab-Blur → blurrt + dimmt Grid.
- CSP / X-Frame-Options: DENY / Referrer-Policy: no-referrer (via Nginx).

## Limitierungen

- Alle Client-DRM-Maßnahmen sind bestenfalls Hürden gegen Gelegenheits-Screenscraper — nichts stoppt einen entschlossenen Angreifer mit Kamera oder instrumentiertem Browser. Ziel ist Deterrenz + nachverfolgbare Watermarks.
- Session-Tokens werden bei Convex nicht automatisch nach dem TTL gelöscht — ein Cron-Job (`convex/crons.ts`) kann das regelmäßig aufräumen (nicht implementiert).
- Admin-Zugriff ist offen — in Produktion `isAdmin` im User-Dokument + Check in `createBook`.

## Legacy

Das alte Prestashop-Modul, FastAPI-Monolith und SQLite-DB liegen noch in `backend/`, `frontend/`, `prestashop-module/`, `drm.db` — nicht mehr im Build. Können gelöscht werden wenn alles läuft.
