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

## Kaufknoepfe im Leser

Der eigene Stripe-Checkout ist aus. Einschalten nur mit
`STRIPE_CHECKOUT_ENABLED=true` in der Convex-Umgebung; das gilt fuer die
Oberflaeche und fuer die Aktionen `billing.createIssueCheckout` /
`createSubscriptionCheckout`.

Ohne Checkout fuehren die Knoepfe in den Laden. Ist die Digital-Kombination
eines Hefts im Laden angeboten (`issues.shopDigital.offered`, SKU in
`shopSku` der Abfragen), geht es direkt in die Kasse:

* „Jetzt kaufen“ (Heftseite) und „Zur Kasse im Shop“ (`/warenkorb`) oeffnen
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
