# Anbindung an einen bestehenden Onlineshop

Der Shop wickelt den Kauf ab, diese Plattform verwaltet nur den digitalen
Zugriff. Es gibt zwei Beruehrungspunkte: die Adresse, unter der die Bibliothek
laeuft, und eine Server-zu-Server-Schnittstelle fuer Freischaltungen.

## Betriebsart

Referenzfall ist eine eigene Subdomain:

```
digital.lesenundschenken.de   ->  Weboberflaeche (Kiosk, Bibliothek, Reader)
api.lesenundschenken.de       ->  Convex-Anwendung
hooks.lesenundschenken.de     ->  Convex-HTTP-Endpunkte (Stripe, Shop)
tiles.lesenundschenken.de     ->  Kachel-Gateway
```

Ein Betrieb unter einem Unterpfad (`lesenundschenken.de/digital/`) ist moeglich:
`VITE_BASE_PATH` setzen und den Reverse Proxy entsprechend konfigurieren. Die
Oberflaeche verdrahtet keine Wurzel-URLs fest.

Fuer die optische Einbettung gibt es `?embed=1`: damit fallen Kopf- und
Fussbereich weg und die Seite fuegt sich in ein fremdes Layout. Ein iframe ist
nur die Rueckfallebene; sauberer ist der Reverse Proxy.

Routen: `/library`, `/kiosk`, `/issue/:slug`, `/reader/:issueId`, `/account`.

## Freischaltung aus dem Shop

```
POST https://hooks.lesenundschenken.de/shop/entitlements
Header: x-shop-signature: <HMAC-SHA256 des Rumpfes, hex>
```

Rumpf:

```json
{
  "externalOrderId": "SHOP-2026-00123",
  "externalCustomerId": "kunde-4711",
  "email": "kunde@example.de",
  "issueSku": "ZUERST-3-2026",
  "action": "grant",
  "timestamp": 1789930000000
}
```

`action` ist `grant` oder `revoke`. Statt `issueSku` geht auch `issueId`.

Signatur bilden (Beispiel PHP, wie in PrestaShop ueblich):

```php
$body = json_encode($payload, JSON_UNESCAPED_UNICODE);
$signature = hash_hmac('sha256', $body, $sharedSecret);
```

Das Geheimnis steht in der Convex-Umgebung unter `SHOP_WEBHOOK_SECRET`.

### Antworten

| Fall | HTTP | Rumpf |
|---|---|---|
| Freigeschaltet | 200 | `{"ok":true,"result":"freigeschaltet"}` |
| Wiederholung derselben Bestellung | 200 | `{"ok":true,"idempotent":true}` |
| Kein Konto zur Adresse | 404 | `{"ok":false,"error":"account_not_found"}` |
| Ausgabe unbekannt | 404 | `{"ok":false,"error":"issue_not_found"}` |
| Signatur falsch | 403 | `{"ok":false,"error":"bad_signature"}` |

Wichtig und bewusst so entschieden: **es wird kein Konto angelegt.** Gibt es zur
Adresse keins, meldet die Schnittstelle das klar zurueck, und der Shop schickt
den Kunden zur Registrierung. Ein vorhandenes, noch unbestaetigtes Konto
bekommt den Zugriff trotzdem.

`revoke` entzieht nur, was der Shop selbst vergeben hat — ein zusaetzlicher
Direktkauf oder eine Abo-Freischaltung bleibt bestehen.

Jeder Aufruf landet in `shopGrants` (idempotent je `externalOrderId` und
Aktion) und im `auditLog`.

## Anmeldung

Die Plattform hat einen eigenen Login. SSO ist im MVP nicht vorgesehen. Bietet
der Shop spaeter OIDC an, kann Convex Auth darauf umgestellt werden; bis dahin
ist die doppelte Anmeldung die bewusste Grenze.
