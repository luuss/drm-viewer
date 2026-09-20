# Artikel aus Heften gewinnen

Der Reader hat zwei Ansichten: die originalgetreue Seite und den Fliesstext je
Artikel. Fuer den Fliesstext muss das Heft in Artikel zerlegt werden. Dafuer
gibt es zwei Wege.

## Weg 1: IDML (empfohlen)

Eine Story im IDML ist genau ein durchgehender Artikeltext — ueber alle
verketteten Textrahmen und Seiten hinweg. Die Grenze, an der jede PDF-Analyse
raten muss, steht dort bereits fest. Zusaetzlich liefern die Absatzformate
Ueberschrift, Vorspann und Autorenzeile.

In InDesign: **Datei → Exportieren → InDesign Markup (IDML)**.

Eine binaere `.indd`-Datei kann der Dienst nicht lesen. Sie ist ein
Binaerformat; ohne InDesign kommt daraus kein verlaesslicher Text.

Fuer wiederkehrende Ausgaben lohnt ein InDesign-Skript, das den IDML-Export mit
einem Klick erledigt.

## Weg 2: PDF

Satzdateien aus InDesign haben eine saubere Textebene, Texterkennung ist also
nicht noetig. Der Dienst arbeitet in dieser Reihenfolge:

1. Bloecke mit Position, Schriftgroesse und Schriftart einlesen.
2. Beiwerk aussortieren: Seitenzahlen, Kolumnentitel, Setzer-Slug, Bildnachweise.
3. Initialen aus dem Ueberschriftenblock loesen und an den Textanfang setzen.
4. Ueber- und Unterschriften anhand der Schriftgroesse klassifizieren.
5. Spalten erkennen und die Lesereihenfolge herstellen.
6. Bloecke zu Artikeln gruppieren, auch ueber Seitengrenzen.
7. Optional: eine KI ordnet die Bloecke nach, wenn `ANTHROPIC_API_KEY` gesetzt ist.
   An das Modell geht nur ein Verzeichnis der Bloecke mit den ersten Zeichen,
   nicht der Volltext. Zurueck kommen nur Gruppen und Titel.

Ergebnis am Testheft (ZUERST! 3/2026, 80 Seiten): 57 Artikel, rund 330.000
Zeichen, ohne KI-Stufe.

## Bilder

Beim PDF-Weg holt der Dienst zusaetzlich die Bilder aus der Seite. Ein Bild
kommt zu dem Artikel, dessen Textflaeche auf derselben Seite am naechsten
liegt. Die Bildunterschrift ist der kleingesetzte Textblock direkt darunter,
sofern er das Bild waagerecht ueberlappt; reine Bildnachweise ("Foto: ...")
werden nicht als Unterschrift uebernommen.

Aussortiert werden Dateien unter 200 Pixel Kantenlaenge oder unter 8 KB — das
sind Logos, Linien und Schmuckelemente. Je Artikel werden hoechstens zwoelf
Bilder uebernommen.

Die Bilder landen im Convex-Speicher und haengen als Verweis am Artikel. Im
Fliesstext-Modus stehen sie ueber dem Text. Am Testheft: 57 Artikel, 166
zugeordnete Bilder.

## Nacharbeit in der Redaktion

Jeder Import landet als **Entwurf**. In der Redaktionsansicht lassen sich
Artikel zusammenfuehren, an der Cursorstelle teilen, umbenennen, im Text
korrigieren und freigeben. Erst freigegebene Artikel sieht der Leser.

Das ist Absicht: eine Erkennung, die in neun von zehn Faellen stimmt, ist ohne
Korrekturschritt keine Entlastung, sondern eine Fehlerquelle.

## Auf der Kommandozeile pruefen

```bash
cd extract-service
.venv/bin/python -m extractor.cli "../hefte test/zuerst 3-2026 innenteil.pdf" \
  --no-llm --out ../_scratch/heft.json
```
