# Von der Druckdatei zur Ausgabe

Eine Ausgabe entsteht in vier Schritten: Quellen hochladen, Leserreihenfolge
festlegen, Aufbereitung starten, redaktionell pruefen. Erst danach laesst sich
die Ausgabe veroeffentlichen.

## 1. Quellen

| Datei | Rolle | Pflicht |
|---|---|---|
| Innenteil-PDF | originalgetreue Seiten und Textebene | ja |
| Umschlag-PDF | Titel, U2, U3, Rueckseite | nein |
| IDML | Artikelstruktur aus dem Satz | nein, aber empfohlen |
| INDD | Archiv | nein |

Eine `.indd`-Datei wird nur abgelegt, nicht ausgewertet. Fuer die automatische
Auswertung braucht es den IDML-Export aus InDesign (Datei → Exportieren →
InDesign Markup).

## 2. Leserreihenfolge

Ein Umschlag kommt aus der Druckvorstufe in Bogenreihenfolge: die Datei beginnt
mit der Rueckseite (U4), dann folgt der Titel (U1), danach U2 und U3. Der
Importdialog schlaegt daraus die Lesereihenfolge U1, U2, Innenteil, U3, U4 vor
und setzt die gedruckten Seitenzahlen ab dem angegebenen Startwert — beim
Musterheft beginnt der Innenteil bei 3.

Der Vorschlag ist nur ein Vorschlag. Nichts davon ist fest verdrahtet, die
Redaktion bestaetigt oder korrigiert ihn. Ergebnis sind `issuePages`: die
kanonische Seitenliste, auf der der Reader arbeitet. Eine zusammengefuegte
Riesendatei entsteht nicht.

## 3. Aufbereitung

Der Auftrag liegt in der Warteschlange (`importJobs`), ein eigener Worker holt
ihn mit einer Sperre ab. Stuerzt der Worker ab, laeuft die Sperre aus und der
Auftrag wird erneut versucht; nach drei Fehlversuchen bleibt er als Fehler
sichtbar.

Je Auftrag:

1. Seiten mit PDFium rendern und im Medienspeicher ablegen.
2. Titelbild aus Seite 1.
3. Text mit pdfplumber lesen: Position, Schriftgroesse, Schriftart.
4. Beiwerk aussortieren: Seitenzahlen, Kolumnentitel, Setzer-Slug, Ueberdruck.
5. Spalten bestimmen und Lesereihenfolge herstellen.
6. IDML auswerten, falls vorhanden.
7. Artikel bauen, Bilder zuschneiden.
8. Ergebnis in einer Transaktion aktivieren.

Der letzte Schritt ist bewusst eine einzige Mutation: bei einem erneuten Import
sehen Leser entweder den alten oder den neuen Stand, nie eine Mischung.

### Was der Parser kann und was nicht

Am Musterheft (ZUERST! 3/2026, 84 Seiten) entstehen rund 60 bis 75 Artikel mit
sauberen Ueberschriften und zusammenhaengendem Fliesstext ueber Seitengrenzen.
Nicht jede Grenze sitzt: bei Bildstrecken und Kaesten trennt die Automatik
gelegentlich zu fein. Dafuer gibt es die Pruefansicht.

Jeder Artikel bekommt ein `confidence`-Mass. Alles unter 0,8 ist ein Hinweis,
zuerst dort hinzuschauen.

### KI-Stufe

Optional kann ein Sprachmodell die Gruppierung nachbessern. Es ist
**standardmaessig aus** und wird nur mit `EXTRACT_USE_LLM=true` und einem
`ANTHROPIC_API_KEY` aktiv. Das Modell bekommt nur ein Verzeichnis der Bloecke
mit den ersten Zeichen und liefert nur Gruppen zurueck — der Text bleibt so, wie
er in der Druckdatei steht.

## 4. Redaktionelle Pruefung

Importierte Artikel haben den Reviewstatus `pending`. Die Redaktion kann:

* Titel, Unterzeile, Autor und einzelne Bloecke bearbeiten,
* Bloecke verschieben, loeschen oder in einen anderen Artikel schieben,
* Artikel zusammenfuehren,
* an einer Blockgrenze trennen — dabei wandern Regionen und Seitenbezug mit,
* Artikel freigeben (`approved`) oder ausschliessen (`excluded`),
* das Inhaltsverzeichnis korrigieren.

Es gibt **keinen** eigenen Veroeffentlichungsschritt je Artikel. Sichtbar wird
ein freigegebener Artikel, sobald seine Ausgabe veroeffentlicht ist; Aenderungen
an ihm sind dann sofort live. Eine Ausgabe laesst sich erst veroeffentlichen,
wenn kein Artikel mehr offen ist.

## Auf der Kommandozeile pruefen

```bash
cd extract-service
.venv/bin/python -m pytest tests -q
```
