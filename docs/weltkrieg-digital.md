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
