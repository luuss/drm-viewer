# Anbindung an einen bestehenden Onlineshop

Der Shop wickelt den Kauf ab, diese Plattform verwaltet nur den digitalen
Zugriff. Es gibt zwei Beruehrungspunkte: die Adresse, unter der die Bibliothek
laeuft, und eine Server-zu-Server-Schnittstelle fuer Freischaltungen.

## Betriebsart

Eine eigene Subdomain, die Dienste liegen unter Pfaden (siehe HANDOVER.md):

```
lesen.lesenundschenken.de/          ->  Weboberflaeche (Kiosk, Bibliothek, Reader)
lesen.lesenundschenken.de/convex/…  ->  Convex-Anwendung (WebSocket)
lesen.lesenundschenken.de/hooks/…   ->  Convex-HTTP-Endpunkte (Stripe, Shop)
lesen.lesenundschenken.de/api/…     ->  Kachel-Gateway
```

Der alte Host `digital.lesenundschenken.de` leitet dorthin um.

Ein Betrieb unter einem Unterpfad (`lesenundschenken.de/digital/`) ist moeglich:
`VITE_BASE_PATH` setzen und den Reverse Proxy entsprechend konfigurieren. Die
Oberflaeche verdrahtet keine Wurzel-URLs fest.

Fuer die optische Einbettung gibt es `?embed=1`: damit fallen Kopf- und
Fussbereich weg und die Seite fuegt sich in ein fremdes Layout. Ein iframe ist
nur die Rueckfallebene; sauberer ist der Reverse Proxy.

Routen: `/library`, `/kiosk`, `/issue/:slug`, `/reader/:issueId`, `/account`.

## Freischaltung aus dem Shop (Vertrag v2)

Verkauft wird nur im PrestaShop auf lesenundschenken.de. Der Leser verwaltet
Konten und Zugriff, verkauft selbst nichts (Stripe-Checkout aus, siehe unten).
Ein Ladenmodul meldet jede bezahlte und jede stornierte Bestellung:

```
POST https://lesen.lesenundschenken.de/hooks/shop/entitlements
Header: content-type: application/json
Header: x-shop-signature: <HMAC-SHA256 des rohen Rumpfes, hex, klein>
```

`digital.lesenundschenken.de` leitet mit 301 auf `lesen.` um. Das Modul muss
direkt `lesen.` ansprechen: viele HTTP-Clients machen aus einem umgeleiteten
POST ein GET ohne Rumpf.

### Rumpf

```json
{
  "externalOrderId": "4711",
  "externalCustomerId": "815",
  "email": "kunde@example.de",
  "action": "grant",
  "items": [
    { "sku": "ZUERST-3-2026", "lineId": "9001" },
    { "sku": "ZUERST-DIGITAL-ABO", "lineId": "9002" },
    { "sku": "BUCH-12345", "lineId": "9003" }
  ]
}
```

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `externalOrderId` | ja | Bestellnummer im Laden (`id_order`), Text oder Zahl |
| `externalCustomerId` | nein | Kundennummer im Laden, nur Protokoll |
| `email` | ja | Adresse der Bestellung; verglichen klein und ohne Leerraum |
| `action` | ja | `grant` (bezahlt) oder `revoke` (storniert, erstattet) |
| `items[].sku` | ja | Artikelnummer (Referenz) der Position |
| `items[].lineId` | ja | Kennung der Position in der Bestellung (`id_order_detail`), Text oder Zahl |

Das Modul schickt **alle** Positionen, auch Druckware. Was keine digitale
Ausgabe ist, wird uebersprungen und ist kein Fehler. Hoechstens 500 Positionen
je Aufruf.

Signatur bilden (PHP):

```php
$body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$signature = hash_hmac('sha256', $body, $sharedSecret);
// genau diesen $body senden, nicht neu kodieren
```

Das Geheimnis steht in der Convex-Umgebung unter `SHOP_WEBHOOK_SECRET`.
Ohne gesetztes Geheimnis ist die Schnittstelle zu (403).

### Zuordnung der Artikelnummern

| Artikelnummer steht in | Ergebnis `kind` | Wirkung |
|---|---|---|
| `issues.externalSku` (Redaktion → Ausgabe) | `issue` | dieses Heft, unbefristet |
| `publications.shopSubscriptionSku` (Redaktion → Titel) | `subscription` | Digital-Abo der Reihe |
| nirgends | `unknown` | uebersprungen |

Eine Artikelnummer ist nur einmal vergebbar, als Heft oder als Abo.

**Digital-Abo:** Zugriff auf alle veroeffentlichten Ausgaben der Reihe, die
zum Abo gehoeren (Schalter "Aus Abo nehmen" in der Redaktion), auch die
aelteren, bis zum Ablaufdatum. Laufzeit aus `shopSubscriptionMonths`, ohne
Angabe 12 Monate. Ein weiterer Kauf verlaengert ab max(jetzt, bisheriges
Ende). Nach Ablauf ist die Reihe wieder zu. `revoke` nimmt genau diese
Position heraus; weitere Abo-Kaeufe derselben Adresse ruecken nach.

**Einzelheft:** unbefristet. `revoke` nimmt nur diese Position zurueck; hat
dieselbe Adresse das Heft in einer anderen Bestellung gekauft, bleibt es
lesbar. Direktkaeufe, Gutscheine und Stripe-Abos bleiben unberuehrt.

### Konto

Es wird kein Konto angelegt. Die Freischaltung haengt an der E-Mail-Adresse
und greift, sobald sich jemand mit dieser Adresse anmeldet, auch wenn das Konto
erst nach dem Kauf entsteht. Angemeldet wird nur per Link an diese Adresse
(Abschnitt "Anmeldung"), die Adresse ist also bewiesen. Der Laden sollte dem
Kunden sagen: "Mit derselben E-Mail unter lesen.lesenundschenken.de anmelden."

### Idempotenz

Je (`externalOrderId`, `lineId`, `action`) wirkt ein Aufruf genau einmal;
Wiederholungen antworten mit `"message": "wiederholt: …"`. Nicht zugeordnete
Positionen (`unknown`) werden nicht als erledigt vermerkt: traegt die Redaktion
die Artikelnummer nach, wirkt ein erneuter Aufruf derselben Bestellung.

### Antwort

Bei gueltiger Signatur und gueltigem Rumpf immer HTTP 200:

```json
{
  "ok": true,
  "results": [
    { "sku": "ZUERST-3-2026", "lineId": "9001", "kind": "issue", "ok": true, "message": "freigeschaltet" },
    { "sku": "ZUERST-DIGITAL-ABO", "lineId": "9002", "kind": "subscription", "ok": true, "message": "Digital-Abo bis 26.09.2027" },
    { "sku": "BUCH-12345", "lineId": "9003", "kind": "unknown", "ok": true, "message": "keine digitale Ausgabe, übersprungen" }
  ]
}
```

| Fall | HTTP | Rumpf |
|---|---|---|
| Signatur falsch oder Geheimnis nicht gesetzt | 403 | `{"ok":false,"error":"bad_signature"}` |
| kein JSON | 400 | `{"ok":false,"error":"bad_json"}` |
| Pflichtfeld fehlt, `action` unbekannt | 400 | `{"ok":false,"error":"missing_field","field":"…"}` |
| `items` kein Array, Position ohne `lineId`, zu viele Positionen | 400 | `{"ok":false,"error":"bad_items","field":"items"}` |

Das Modul sollte bei 5xx und Zeitueberschreitung wiederholen; wegen der
Idempotenz ist das gefahrlos.

### Altes Einzelformat (v1)

Bleibt gueltig: ohne `items`, dafuer `issueSku` oder `issueId`. Die Position
heisst dann wie die Artikelnummer. Antwort im v2-Format.

```json
{ "externalOrderId": "4711", "email": "kunde@example.de", "issueSku": "ZUERST-3-2026", "action": "grant" }
```

### Protokoll

Jede wirksame Position landet in `shopGrants` und im `auditLog`, der Zugriff
selbst in `shopAccess` (eine Zeile je Bestellposition).

## Shop-API (Leser → Laden)

Umgekehrte Richtung: der Leser fragt den Laden nach Produkten und legt dort die
Digital-Kombination am Druckheft an. Umgesetzt im PrestaShop-Modul `lusdigital`
(Quelle: `lesen-und-schenken-shop-theme/_local-modules/lusdigital/`).

```
POST https://lesenundschenken.de/module/lusdigital/api
Header: content-type: application/json
Header: x-shop-signature: hex(HMAC-SHA256(roher Rumpf, LUSDIGITAL_SECRET))
```

* Nur POST. Die Aktion steht im Rumpf (`action`), dazu immer `ts` in
  Unix-Sekunden.
* Dasselbe Geheimnis und dasselbe Verfahren wie bei den Meldungen: im Laden
  `LUSDIGITAL_SECRET`, im Leser `SHOP_WEBHOOK_SECRET`.
* 403 bei falscher oder fehlender Signatur (`bad_signature`), bei `ts`, das
  mehr als 300 s von der Serverzeit abweicht (`bad_timestamp`), und solange im
  Laden kein Geheimnis gesetzt ist (`not_configured`).
* Fehler immer als `{"ok":false,"error":"<code>","message":"<deutscher Text>"}`.

### Produktformat

```json
{
  "id": 10528,
  "name": "Robert Ritter von Greim",
  "reference": "478364",
  "price_gross": 13.8,
  "url": "https://lesenundschenken.de/10528-robert-ritter-von-greim.html",
  "cover_url": "https://lesenundschenken.de/8828-large_default/robert-ritter-von-greim.jpg",
  "manufacturer": "Schwertertraeger Heft 36",
  "active": true,
  "digital": null
}
```

`price_gross` ist der Druckpreis (Standardkombination), brutto, Euro, mit
Rabatten wie im Laden. `cover_url` kann `null` sein. `digital` ist `null`,
solange es keine Digital-Kombination gibt, sonst:

```json
{ "id_product_attribute": 659, "sku": "ST-36-DIGITAL", "price_gross": 4.9, "available": true }
```

`available` ist nur `true`, wenn die Kombination existiert **und** das Produkt
aktiv ist. Nach `withdraw_digital` steht `id_product_attribute: null`,
`available: false`; `sku` und der letzte Preis bleiben zur Anzeige erhalten.

### Aktionen

| Aktion | Rumpf | Antwort |
|---|---|---|
| `search` | `{"action":"search","q":"DMZ Nr. 170","ts":…}` | `{"ok":true,"products":[…]}` (hoechstens 20) |
| `product` | `{"action":"product","id":10528,"ts":…}` | `{"ok":true,"product":{…}}`, 404 `product_not_found` |
| `offer_digital` | `{"action":"offer_digital","id_product":10528,"sku":"ST-36-DIGITAL","price_gross":4.9,"available":true,"ts":…}` | `{"ok":true,"id_product_attribute":659,"available":true,"price_gross":4.9,"url":"…#/68-ausgabe-digital"}` |
| `withdraw_digital` | `{"action":"withdraw_digital","id_product":10528,"sku":"ST-36-DIGITAL","ts":…}` | `{"ok":true,"id_product_attribute":null,"available":false}` |
| `quote` | `{"action":"quote","skus":["ST-36-DIGITAL"],"country_iso":"DE","ts":…}` | `{"ok":true,"total_cents":1380,"tax_cents":90,"items":[{"sku":…,"price_cents":1380,"tax_rate":7}]}`; 409 `sku_unknown` (nur Digitalausgaben) |
| `create_order` | siehe „Kartenkauf im Leser“ | `{"ok":true,"id_order":291,"reference":"CRGATIWJM","state":2,"paid":true,"total_cents":1380,"repeated":false}` |
| `refund_order` | `{"action":"refund_order","mode":"live","payment_intent":"pi_…","ts":…}` | `{"ok":true,"state":7,"refunded_cents":1380,"full":true}` |
| `send_mail` | `{"action":"send_mail","template":"lusdigital_login","to":"kunde@example.de","link":"https://lesen.lesenundschenken.de/anmelden?t=…","ts":…}` | `{"ok":true}`; 400 `bad_template`/`bad_email`/`bad_link`, 429 `rate_limited`, 502 `mail_failed` |

**Suche.** Jedes Wort muss in Name, Referenz, Hersteller, Merkmal „Ausgabe“
oder einem Kategorienamen vorkommen. Reine Zahlen zaehlen nur als ganze Zahl
(`36` trifft nicht `360`). `3/2026` wird zu `März 2026`, weil die ZUERST!-Hefte
so heissen. Treffer, bei denen der ganze Suchtext ein Feld genau oder als
Teilstueck trifft, stehen vorn, danach die neuesten. Gesucht werden nur
Produkte, keine Kombinationen, auch inaktive (`active` sagt, ob kaufbar).
Geprueft am 26.09.2026: „Schwertertraeger Heft 36“ → 10528, „DMZ Nr. 170“ →
10491, „DMZ-ZG Nr. 80“ → 10492, „ZUERST! 3/2026“ → 10490, jeweils als erster
Treffer.

**offer_digital** ist idempotent ueber die SKU:

* Hat das Produkt noch keine Kombinationen, entsteht zuerst „Ausgabe: Druck“
  (Standard, Preis- und Gewichtsaufschlag 0, Bestand und „bestellbar ohne
  Bestand“ vom Produkt uebernommen, Referenz leer → Bestellzeilen tragen
  weiter die Produktreferenz). Druckpreis, Bilder und Bestellbarkeit bleiben
  unveraendert; weicht der Druckpreis danach trotzdem ab, steht das in
  `warnings`.
* Dann „Ausgabe: Digital“ mit Referenz = `sku`, Aufschlag so, dass der
  Bruttopreis `price_gross` ergibt (Steuersatz des Produkts), Gewicht 0,
  bestellbar ohne Bestand. Ein zweiter Aufruf mit derselben SKU aendert Preis
  bzw. Referenz derselben Kombination.
* `available: false` wirkt wie `withdraw_digital`.
* Weicht der Shop-Preis danach vom gewuenschten ab (z. B. Rabatt am Produkt),
  steht der tatsaechliche in `price_gross` und ein Satz in `warnings`.
* Fehler: `sku_in_use` (409, SKU haengt an einem anderen Produkt oder ist
  schon eine Referenz im Laden), `has_other_combinations` (409, Produkt hat
  schon Groessen o. Ae.), `product_virtual` (409, Produkt ist bereits
  virtuell), `bad_sku` (400, erlaubt `A–Z a–z 0–9 . _ -`, hoechstens 64),
  `bad_price` (400).

**withdraw_digital** loescht die Digital-Kombination. PrestaShop kann eine
einzelne Kombination nicht deaktivieren; geloescht ist sie sicher nicht mehr
kaufbar und verschwindet auch aus offenen Warenkoerben. Bestellungen behalten
Name und Referenz in der Bestellzeile, Freischaltungen laufen ueber die SKU
weiter. Ein spaeteres `offer_digital` legt eine neue Kombination an (neue
`id_product_attribute`).

Versand: Warenkorbzeilen mit „Ausgabe: Digital“ gelten im Laden als virtuell.
Ein Warenkorb nur aus Digitalpositionen hat keinen Versandschritt; im
gemischten Warenkorb zaehlt nur die Druckware fuer Versandkosten und
Freigrenze.

Stand und Betrieb des Moduls: `../../docs/digital-verkauf-shop.md`.

## Buchanzeigen im Heft (seit 30.09.2026)

Die Hefte tragen Anzeigen fuer Buecher aus dem eigenen Laden und
Buchbesprechungen. Der Import macht daraus kurze Artikel. Der Leser verbindet
sie mit dem Produkt im Laden: im Artikel steht unter dem Anzeigentext der
Knopf "Im Shop bestellen", im Seitenmodus oeffnet ein Tipp auf die Anzeige die
Auswahl "bestellen oder Text lesen". Der Knopf fuehrt auf die Produktseite,
immer in einem neuen Tab. Fremdanzeigen haben kein Produkt im Laden und
bleiben ohne Knopf.

Code: `convex/articleProductRules.ts` (Regeln, reine Funktionen),
`convex/articleProducts.ts` (Abgleich, Abfragen, Korrekturen),
`web/src/reader/ShopProduct.tsx`, `web/src/admin/ArticleProducts.tsx`.

### Zuordnung

Nach jedem Import laeuft `articleProducts:matchInternal` fuer die Ausgabe
(Shop-API `search`, je Suchbegriff ein Aufruf):

1. **Artikelnummer.** "Art. 101208", "Art.-Nr.", "Artikelnummer", "Best.-Nr."
   mit fuenf oder sechs Ziffern ist die Produktreferenz im Laden. Verlinkt
   wird nur bei genau einem Produkt mit genau dieser Referenz.
2. **Titel**, wenn keine Nummer dabeisteht. Erkannt wird die Buchbeschreibung
   an der Umfangsangabe ("216 S., s/w. Abb., Pb., € 17,90"). Gesucht wird mit
   den Titelzeilen darueber bzw. mit der Literaturangabe einer Besprechung
   ("Verfasser. Titel. 368 S., geb., …"). Die Ladensuche ist unscharf, deshalb
   zaehlt ein Treffer nur, wenn sein Name woertlich in der Titelzone steht,
   und nach Punkten: Preis gleich +2, Verfasser (Herstellerfeld) in der
   Titelzone +2, Name ist genau eine Zeile +1, Name hat drei Woerter +1, Name
   ist ein Wort -1, Preis verschieden -1. Ab 3 Punkten wird verlinkt; bei
   Gleichstand (Baende gleichen Namens und Preises) nicht.

Fuehrt der Laden das Buch einer erkannten Anzeige nicht (nicht gefunden, kein
eindeutiger Treffer, Titel nur im Bild, Produkt inzwischen herausgenommen),
zeigt der Leser stattdessen den Knopf "Zum Shop" auf die Startseite des
Ladens, hoechstens einen je Artikel. Die Redaktion stellt ihn mit "Kein Knopf"
ab oder waehlt ein Produkt.

Das Euro-Zeichen kommt in den DMZ-Schriften als "t" aus dem Satz ("t 29,80");
die Preiserkennung nimmt beides.

Stand der vier Hefte am 30.09.2026: 22 von 22 Artikelnummern zugeordnet
(DMZ 170, DMZ-Zeitgeschichte 80), 9 von 15 Beschreibungen ohne Nummer. Offen
bleiben drei Buecher, die der Laden nicht fuehrt, "Veteranen der Waffen-SS
berichten, Bd. 12" (zwei Baende gleichen Namens und Preises) und zwei
Anzeigen, deren Titel nur auf dem abgebildeten Umschlag steht.

### Daten

| Tabelle | Inhalt |
|---|---|
| `articleProducts` | je Anzeigenabsatz eine Zeile: `blockId`, `source` (`number`, `title`, `editor`), `productId`; ohne `productId` ist die Anzeige erkannt, aber offen (`note` sagt warum, Knopf "Zum Shop"), bei `source: editor` ausdruecklich ohne Knopf |
| `shopProducts` | Name, Adresse, Preis, `active` je Produkt, Stand der Shop-API |
| `productOverrides` | Entscheidung der Redaktion je Absatz, unter dem Schluessel seines Textes |

Die Zeile haengt am Absatz, nicht am Artikel: sie wandert mit, wenn die
Redaktion Artikel trennt oder zusammenfuehrt. Adressen kommen nur aus der
Antwort des Ladens und nur von `lesenundschenken.de`.

Der Seitenmodus fragt nur bei kurzen Artikeln (bis 3000 Zeichen) erst nach.
Steht eine Anzeige in einem langen Artikel, oeffnet der Tipp den Artikel und
der Knopf steht an seiner Stelle im Text.

### Redaktion

Pruefansicht → Artikel oeffnen → "Produkte im Netzladen": falsche Verknuepfung
entfernen, offener Anzeige ein Produkt geben oder den Knopf abstellen ("Kein
Knopf"), weiteres Produkt ergaenzen
(Suche nach Titel, Artikelnummer oder eingefuegter Produktadresse),
"Automatik" nimmt die Entscheidung zurueck. Eine Entscheidung gilt auch nach
einem neuen Import und fuer denselben Anzeigentext in spaeteren Heften.
"Mit dem Netzladen abgleichen" stoesst den Abgleich von Hand an.

### Nachfuehren

Taeglich 04:45 UTC (`articleProducts:refreshInternal`): bis zu 200 Produkte
mit der aeltesten Pruefung per `product` neu lesen (Preis, Adresse, `active`;
ein geloeschtes Produkt verliert den Knopf) und Hefte der letzten 60 Tage mit
offenen Anzeigen neu abgleichen, weil ein Buch oft erst nach dem Heft im
Laden steht. Antwortet der Laden beim Abgleich nicht, bleibt der alte Stand
und der Lauf wiederholt sich nach 5 min, 30 min und 2 h.

Von Hand:

```bash
npx convex run --env-file _scratch/verlag-direkt.env \
  articleProducts:matchInternal '{"issueId":"<id>"}'
```

## Kaufknoepfe im Leser

Der alte eigene Stripe-Checkout ist aus (`STRIPE_CHECKOUT_ENABLED`, Aktionen
`billing.createIssueCheckout` / `createSubscriptionCheckout`); sein Webhook
liegt jetzt unter `/stripe/checkout-alt/webhook`.

Ist die Digital-Kombination eines Hefts im Laden angeboten
(`issues.shopDigital.offered`, SKU in `shopSku` der Abfragen):

* **Kartenkauf eingeschaltet** (`LESER_STRIPE_MODE`): „Jetzt kaufen“
  (Heftseite) und „Zur Kasse“ (`/warenkorb`) oeffnen die Kasse im Leser
  (`web/src/components/Kasse.tsx`), siehe naechster Abschnitt. Darunter der
  Link „Andere Zahlart (Rechnung, Vorkasse, SEPA) im Shop“ auf
  `lusdigital/warenkorb` (unten).
* **Kartenkauf aus**: „Jetzt kaufen“ und „Zur Kasse im Shop“ oeffnen
  `https://lesenundschenken.de/module/lusdigital/warenkorb?artikel=<SKUs>&email=<Konto>`.
  Der Laden legt die Hefte in den Warenkorb und leitet in die Kasse, die
  E-Mail ist dort vorbelegt.
* Der Warenkorb im Leser ist nur eine Auswahl im Browser
  (`web/src/lib/warenkorb.ts`, localStorage), Knopf „In den Warenkorb“ auf
  Heftseite und Kiosk-Karte.

Sonst:

* Ausgabe: `issues.shopUrl` (Redaktion → Ausgabe → Bearbeiten), sonst
  `https://lesenundschenken.de/suche?s=<Heftname>`.
* Digital-Abo: `publications.shopSubscriptionUrl` (Redaktion → Titel), sonst
  die Suche nach dem Namen der Reihe.

`issues.shopUrl` ist zugleich die Seite, die der naechtliche Abgleich
(`publicationCovers.refreshAll`) fuer Heftbezeichnung und Preis liest.

## Kartenkauf im Leser (seit 29.09.2026)

Angemeldete Leser zahlen mit Karte direkt im Leser, ohne Umleitung. Beim ersten
Kauf Karte im Stripe Payment Element (Karte, Apple Pay, Google Pay; Link aus),
auf Wunsch gespeichert. Danach ein Klick: „Jetzt zahlungspflichtig kaufen –
13,80 € mit Visa •••• 4242“. Gaeste sehen in der Kasse das Anmeldeformular
(E-Mail-Link, `next` fuehrt mit `?kaufen=1` zurueck in die Kasse) und den
Shop-Link fuer andere Zahlarten.

**Gebucht wird im Shop.** Jede Zahlung wird dort eine echte Bestellung mit
Rechnung; erst deren Status „bezahlt“ schaltet frei, ueber denselben Weg wie
jeder Shop-Kauf (`actionOrderStatusPostUpdate` → `/shop/entitlements`). Der
Leser schaltet nichts selbst frei.

```
Kasse (Browser)                      Leser (Convex)                  Shop (lusdigital)          Stripe
angebot ───────────────────────────► leserZahlung.angebot ─────────► quote
kaufen (Adresse, Verzicht) ────────► leserZahlung.kaufen ──────────────────────────────────────► PaymentIntent
  neue Karte: confirmPayment ─────────────────────────────────────────────────────────────────► (3-D Secure im Dialog)
  gespeicherte Karte: confirm auf dem Server, bei requires_action handleNextAction
kaufPruefen ───────────────────────► zahlungEingegangen ◄──────────── Webhook payment_intent.succeeded
                                     bestellungAnlegen ─────────────► create_order ──► prueft PI bei Stripe
                                                                      validateOrder (bezahlt) ──► grant an /shop/entitlements
```

* Stripe-Konto: das des Shops (`acct_1QuW3G…`). Schluessel in der
  Convex-Umgebung: `LESER_STRIPE_MODE` (`test`|`live`, leer = aus),
  `LESER_STRIPE_SECRET_KEY_TEST|_LIVE`, `LESER_STRIPE_PUBLISHABLE_KEY_TEST|_LIVE`,
  `LESER_STRIPE_WEBHOOK_SECRET_TEST|_LIVE`. Die Schluessel stammen aus der
  Shop-Konfiguration (`STRIPE_TEST_KEY`, `STRIPE_KEY`, …). Umschalten:
  `npx convex env set LESER_STRIPE_MODE test` (ueber den Tunnel).
* Webhook: `https://lesen.lesenundschenken.de/hooks/stripe/webhook`
  (`convex/leserWebhook.ts`), je Modus ein Endpunkt in Stripe (test
  `we_1UL6eY…`, live `we_1UL6tJ…`), Ereignisse `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`.
  Beachtet wird nur, was `metadata.source = "leser"` traegt bzw. zu einem
  Kauf in `leserKaeufe` gehoert.
* Jeder PaymentIntent: `payment_method_types: ["card"]`, Metadaten `source`,
  `kaufId`, `userId`, `email`, `skus`; nach der Buchung `shop_order`,
  `shop_reference`. Nie `id_cart`: sonst legte `stripe_official` selbst
  eine Bestellung an.
* Preis: kommt vor dem Bezahlen aus dem Shop (`quote`, gleicher Warenkorb wie
  bei `create_order`). `kaufen` bricht ab, wenn er sich seit der Anzeige
  geaendert hat.
* Rechnungsadresse (Pflicht beim ersten Kauf, Tabelle `leserKunden`), Karte
  nur als Marke/letzte 4/Ablauf (`leserKarten`, je Modus eigener
  Stripe-Kunde), Kaeufe in `leserKaeufe`, Widerrufsverzicht je Heft in
  `consents` (PaymentIntent in `stripeSessionId`). Konto → „Zahlungsdaten“:
  Karte entfernen (loest sie bei Stripe). Kontoloeschung nimmt Adresse und
  Karte mit (`leserDatenLoeschen`).
* Schlaegt `create_order` fehl, wiederholt der Leser nach 30 s, 2, 10, 30,
  60 min, 3, 6, 12 h; danach Status `fehler` und `auditLog`
  `leser.bestellfehler`. Die Kasse sagt dem Kunden: Zahlung da,
  Freischaltung verzoegert.
* Erstattung **nur im Stripe-Dashboard**: `charge.refunded` → `refund_order`
  → Status „Erstattet“ (7) → revoke. Teilerstattung: nur Notiz an der
  Bestellung. Rueckbuchungen werden nur geloggt.
* Kein `"use node"`: Node-Aktionen erreichen auf dem Verlagsserver das Backend
  nicht. Stripe wird per `fetch` angesprochen (`convex/stripeRest.ts`).

### `create_order`

```json
{"action":"create_order","ts":…,"mode":"live","payment_intent":"pi_…","amount_cents":1380,
 "email":"kunde@example.de","skus":["SCHWERTERTRAEGER-36-DIGITAL"],
 "firstname":"Erika","lastname":"Mustermann","company":"","address1":"Hauptstraße 1",
 "address2":"","postcode":"10115","city":"Berlin","country_iso":"DE"}
```

Im Shop (`classes/LeserKauf.php`):

1. Idempotent je PaymentIntent (Tabelle `ps_lusdigital_leserkauf`). Liegt
   schon eine Bestellung vor, kommt sie mit `repeated: true` zurueck; laeuft
   gerade ein Aufruf, 409 `busy`.
2. Fragt Stripe selbst (Schluessel aus `stripe_official`): Status
   `succeeded`, Betrag, EUR, `metadata.source = leser`, richtiger Modus.
3. Gastkunde zur E-Mail (immer ein Gastkonto, nie ein registriertes
   Shop-Konto), Rechnungsadresse (Alias „Leser“), Warenkorb nur mit
   Digitalausgaben (Kombination „Ausgabe: Digital“ oder virtuelles Produkt).
4. `validateOrder` mit Zahlart „Stripe (Leser)“, Status 2 „Zahlung
   eingegangen“ (Rechnung, Mails wie sonst), `transaction_id` = PaymentIntent,
   private Notiz mit Widerrufsverzicht. Weicht die Warenkorbsumme vom
   bezahlten Betrag ab, setzt PrestaShop selbst „Fehler bei der Bezahlung“
   (8), es steht im Log, die Antwort traegt `warnings`, der Leser vermerkt
   `fehler`.
5. Testmodus: Zahlart „Stripe (Leser, TEST)“, eigener Status 28
   „Testzahlung Leser (keine Rechnung)“ (bezahlt, ohne Rechnung, damit keine
   Rechnungsnummer verbraucht wird), keine Mails (Hook
   `actionEmailSendBefore`), Erstattung setzt „Storniert“ (6) statt 7.

`stripe_official` bekommt die Leser-Ereignisse ebenfalls (ein Konto). Es
findet keinen Warenkorb, antwortet 200, legt nichts an und schreibt eine
Zeile „Not a valid cart“ (Schwere 3, keine Mail) ins Shop-Log. Geprueft am
29.09.2026 mit einem signierten Probeereignis. Auch weltkrieg-online.de
(WooCommerce) und zuerst.de haengen am Konto und ignorieren fremde Zahlungen.

### Durchgangstest (29.09.2026, Testmodus)

Heft „Greim“ (10528/662, 13,80 €), Wegwerfkonten `kasse-test-20260929{a,b,c}@example.com`:

| Fall | Ergebnis |
|---|---|
| Erstkauf, Karte 4000 0025 0000 3155 mit 3-D Secure, speichern | bezahlt → Bestellung CRGATIWJM, Status Testzahlung, 13,80 € brutto / 12,90 € netto, 7 %, Versand 0, grant ok, Heft lesbar, 5 s |
| Erstattung im Stripe-Dashboard (API) | Status Erstattet, revoke ok, Heft zu |
| Ein Klick mit gespeicherter 3155 | 3-D Secure per `handleNextAction`, bezahlt, grant ok |
| Erstkauf 4242, Erstattung, ein Klick 4242 | ohne Rueckfrage bezahlt, 2 s bis frei |
| Warenkorb (`/warenkorb`), Adresse Oesterreich | bezahlt, frei, Auswahl geleert |
| Konto: Karte entfernen | bei Stripe geloest, im Konto weg |

Danach geloescht: 5 Testbestellungen, 3 Gastkunden, Konten im Leser
(`account:purgeByEmailInternal`), Testkaeufe (`leserKasse:testkaeufeLoeschen`),
Stripe-Testkunden. Werkzeuge auf dem Server in `~/lusdigital-tools/`:
`bestellungen-pruefen.php`, `testbestellungen-loeschen.php` (Probelauf,
`--los` loescht nur Bestellungen mit „TEST“ in der Zahlart), `shop-api.php`
(signierter Aufruf), `wert.php` (ein Konfigurationswert fuer Pipes).

### Erster Livekauf (Betreiber)

1. Unter https://lesen.lesenundschenken.de mit der eigenen Adresse anmelden.
2. Heft mit Digitalausgabe oeffnen (z. B. „Greim“), „Jetzt kaufen“,
   Rechnungsadresse, echte Karte, „Karte speichern“ an, Widerrufsverzicht,
   „Jetzt zahlungspflichtig kaufen – 13,80 €“.
3. Erwartung: nach wenigen Sekunden „Bezahlt und freigeschaltet, Bestellung
   …“, „Jetzt lesen“ oeffnet das Heft. Mail mit Bestellbestaetigung vom Shop.
4. Shop-Backoffice: Bestellung mit Zahlart „Stripe (Leser)“, Status
   „Zahlung eingegangen“, Rechnung, 7 %, kein Versand; Module → lusdigital →
   „Letzte Meldungen“: grant ok.
5. Konto → Zahlungsdaten: Karte steht dort.
6. Stripe-Dashboard → Zahlung → voll erstatten. Erwartung: Bestellung
   „Erstattet“, Meldung revoke ok, Heft wieder zu.
7. Wer mag: noch einmal kaufen, jetzt ein Klick mit der gespeicherten Karte,
   und wieder erstatten.

## Anmeldung

Ohne Passwort, per E-Mail-Link (seit 29.09.2026). Anmelden und Registrieren
sind derselbe Weg: Adresse eingeben, Link aus der Mail anklicken, angemeldet.
Das Konto entsteht beim ersten gueltigen Klick, erst dann ist die Adresse
bewiesen. Bestehende Konten (frueher mit Passwort) werden ueber `users.email`
gefunden und behalten Id, Rollen, Kaeufe und Freischaltungen.

```
POST https://lesen.lesenundschenken.de/hooks/auth/link
Rumpf: {"email":"kunde@example.de","next":"/issue/zuerst-3-2026"}
200 {"ok":true} · 400 bad_email · 429 rate_limited · 502 mail_failed
```

* Die Antwort ist fuer bekannte und unbekannte Adressen gleich. Die Seite
  sagt: "Wenn die Adresse stimmt, kommt gleich eine E-Mail."
* Der Leser hat keinen eigenen Mailversand. Er ruft die Shop-API `send_mail`
  (signiert wie alle Aktionen). Der Shop verschickt ueber sein Postfix mit
  DKIM, Absender `bestellung-netzladen@lesenundschenken.de`, Vorlage
  `lusdigital/mails/de/lusdigital_login.{html,txt}`. Der Shop nimmt nur diese
  Vorlage, nur Links auf `https://lesen.lesenundschenken.de/` und hoechstens
  5 Mails je Empfaenger und Stunde (Tabelle `ps_lusdigital_mail`).
* Link: `https://lesen.lesenundschenken.de/anmelden?t=<token>&next=<pfad>`.
  Token: 32 Zufallsbytes, gespeichert nur als SHA-256 (`magicLinks`), gilt
  15 Minuten und einmal. `next` nur als Pfad auf derselben Seite
  (`magicLinkRules.safeNext`), sonst `/library`.
* Grenzen im Leser je Stunde: 5 Links je Adresse, 20 je IP
  (`cf-connecting-ip`, sonst `x-forwarded-for`), 500 insgesamt.
* Die Seite `/anmelden` ruft `signIn("magic-link", {token})` (Convex Auth,
  `ConvexCredentials` in `convex/auth.ts`). Der Link meldet den Browser an,
  in dem er sich oeffnet, auf dem Handy also meist den Browser der Mail-App.
* Oeffnet eine Mail-Pruefung (z. B. Outlook Safe Links) den Link mit
  JavaScript, ist er verbraucht. Die Seite bietet dann sofort einen neuen an.
* Gastkaeufe ueber Stripe (`claimTokens`) werden beim Anmelden mit der
  Kaufadresse automatisch eingeloest. `/claim/<token>` fuehrt nur noch auf
  `/login`.

### Hoechstens zwei Browser

Ein Konto ist in hoechstens zwei Browsern zugleich angemeldet
(`MAX_LOGIN_SESSIONS`, Standard 2). Die dritte Anmeldung beendet die aelteste
(`authSessions` samt `authRefreshTokens`, Callback `beforeSessionCreation`,
`convex/sessions.ts`). Der verdraengte Browser merkt es sofort ueber die
Abfrage `sessions.current` und meldet sich ab. Das JWT gilt 15 Minuten; danach
scheitert ohnehin jedes Auffrischen.

Lesesitzungen (`readerSessions`, Token fuer das Kachel-Gateway) haengen an der
Anmeldung (`authSessionId`) und enden mit ihr. Je Anmeldung hoechstens zwei
offene Hefte (`MAX_ACTIVE_SESSIONS`). Frueher galt die Grenze je Konto, dann
warfen sich zwei eigene Geraete mit demselben Heft gegenseitig hinaus.

Die Kontoseite zeigt die angemeldeten Browser mit "Abmelden" je Browser.

Sitzungsdauer: 30 Tage ohne Nutzung, hoechstens 90 Tage, danach neuer Link.
SSO mit dem Shop gibt es nicht.
