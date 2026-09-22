# Von der Druckdatei zur Ausgabe

Eine Ausgabe entsteht in vier Schritten: Quellen hochladen, Leserreihenfolge
festlegen, Aufbereitung starten, redaktionell pruefen. Erst danach laesst sich
die Ausgabe veroeffentlichen.

Der uebliche Weg nimmt alle vier Schritte auf einmal: den Heftordner der
Druckvorstufe in die Redaktionsoberflaeche ziehen. Die Abschnitte darunter
beschreiben, was dabei geschieht, und gelten ebenso fuer den Weg von Hand.

## 0. Heftordner einlesen

Die Druckvorstufe liefert je Heft einen Ordner, immer im selben Zuschnitt:

```
dmz 170, innenteil + titelseite/
  DMZ 170 innen.pdf        Innenteil, die Vorlage fuer alle Seiten
  dmz 170 titel.tif        Titelseite, CMYK in Druckaufloesung
  dmz 170 titel.jpg        dieselbe Titelseite, klein
  DMZ 170.idml             Satzdatei, Artikelstruktur und Bildrahmen
  DMZ 170.indd             Archiv
  Links/                   die platzierten Bilder, meist ueber ein Gigabyte
  Document fonts/          Schriften
```

Ein solcher Ordner ist ein bis zwei Gigabyte gross. Davon gehoeren nur
Innenteil und Satzdatei unveraendert auf den Server — zusammen selten mehr als
siebzig Megabyte. Alles Uebrige entscheidet der Browser:

| Teil | Was geschieht |
|---|---|
| Innenteil-PDF | geht unveraendert hoch, Seitenzahl wird gezaehlt |
| Umschlag-PDF | geht unveraendert hoch, falls es eins gibt |
| IDML | geht unveraendert hoch |
| Titelseite (TIF/JPG) | wird im Browser in ein JPEG umgewandelt und als erste Seite gefuehrt |
| `Links/` | wird im Browser verkleinert, hoechstens 1600 Bildpunkte je Kante |
| `.indd`, `Document fonts/` | bleiben liegen |

Reihe und Heftnummer liest der Dialog aus dem Ordnernamen: `dmz 170` wird die
Reihe `dmz`, Heft `170`; `schwertertraeger 36 greim` wird Heft `36` mit dem
Titel `Greim`; `zuerst 3-2026` wird Heft `3/2026`. Eine schon gepflegte Reihe
steht mit ihrem Namen da, nicht mit der Abkuerzung aus dem Ordner. Gibt es das
Heft mit dieser Nummer schon, werden dessen Quellen ersetzt statt ein zweites
angelegt; ein zweiter Wurf desselben Ordners macht also nichts doppelt.

Warum die Bilder im Browser umgewandelt werden und nicht auf dem Server: ein
Heft bringt gut ein Gigabyte CMYK-TIFF mit, von dem im Netz niemand etwas hat.
Die Umwandlung laeuft in einem Hintergrundfaden (`web/src/admin/convertWorker.ts`),
damit die Oberflaeche waehrenddessen bedienbar bleibt. TIFF liest UTIF, der
Browser selbst kann es nicht. Was sich nicht lesen laesst — `.ai`, `.eps`, eine
beschaedigte Datei — wird uebergangen und im Protokoll genannt; der Import
laeuft weiter.

## 1. Quellen

| Datei | Rolle | Pflicht |
|---|---|---|
| Innenteil-PDF | originalgetreue Seiten und Textebene | ja |
| Umschlag-PDF | Titel, U2, U3, Rueckseite | nein |
| Titelseite als Bild | erste Seite, wenn kein Umschlag-PDF kommt | nein |
| IDML | Artikelstruktur aus dem Satz | nein, aber empfohlen |
| INDD | Archiv, mehrere moeglich | nein |
| Platzierte Bilder | Artikelbilder in Netzgroesse | nein |

Eine `.indd`-Datei wird nur abgelegt, nicht ausgewertet. Innenteil und
Umschlag haben in der Regel je eine eigene; beide werden behalten, nur eine
Datei gleichen Namens ersetzt ihre Vorgaengerin. Fuer die automatische
Auswertung braucht es den IDML-Export aus InDesign (Datei → Exportieren →
InDesign Markup).

Warum die `.indd` nicht ausgewertet werden kann und wie der Verlag mehrere
Dateien auf einmal exportiert: [indesign-idml.md](indesign-idml.md).

Die Seitenzahl eines PDF bestimmt der Importdialog beim Hochladen selbst.
Gelingt das nicht (komprimierte Objektstroeme), bleibt das Feld leer und die
Redaktion traegt sie in der Quellenliste ein.

## 2. Leserreihenfolge

Ein Umschlag kommt aus der Druckvorstufe in einer von zwei Formen:

* **Vier Einzelseiten in Bogenreihenfolge** (ZUERST!): die Datei beginnt mit
  der Rueckseite (U4), dann folgt der Titel (U1), danach U2 und U3.
* **Zwei Doppelseiten** (DMZ): der erste Bogen zeigt links U4 und rechts U1,
  der zweite links U2 und rechts U3. Jede Leserseite ist dann eine Haelfte
  der Quellseite (`issuePages.sourceHalf`). Der Worker rendert und liest nur
  diese Haelfte des Netzformats; eine zerschnittene Datei entsteht nicht.

Der Importdialog erkennt die Form an der Seitenzahl der Umschlagdatei (2 oder
4) und laesst sie ausdruecklich waehlen. Daraus schlaegt er die Lesereihenfolge
U1, U2, Innenteil, U3, U4 vor und setzt die gedruckten Seitenzahlen ab dem
angegebenen Startwert — bei beiden Musterheften beginnt der Innenteil bei 3.

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
3. Satzdatei auswerten: Absaetze mit Absatzformat, Textrahmen mit Lage und
   Verkettung, Bildrahmen mit Dateinamen.
4. Beiwerk aussortieren: Seitenzahlen, Kolumnentitel, Wiederholer.
5. Gedrucktes Inhaltsverzeichnis aus dem Satz lesen.
6. Fuer Seiten ohne Satzdatei — meist der Umschlag — den Text mit pdfplumber
   aus dem PDF lesen und Spalten bestimmen.
7. Artikel bauen, Bilder zuschneiden oder das Originalbild nehmen.
8. Ergebnis in einer Transaktion aktivieren.

**Die Satzdatei ist die Hauptquelle.** Sie weiss, was eine Ueberschrift ist und
was eine Zwischenzeile, welche Absaetze zu einem Text gehoeren und wo ein Bild
steht. Das PDF muss dasselbe an Schriftgroessen und Abstaenden erraten. Liegt
eine IDML vor, wird der Text also aus ihr gelesen und das PDF nur noch fuer das
Bild der Seite gebraucht.

### Eine Story ist ein Artikel

InDesign speichert Text nicht seitenweise, sondern als Fluss: eine **Story**
laeuft durch beliebig viele verkettete Rahmen ueber beliebig viele Seiten, und
die Reihenfolge ihrer Absaetze steht in der Datei. Damit ist die Artikelgrenze
keine Schaetzung mehr:

* Eine Story im Mengentextformat **ist** ein Artikel — kein Inhaltsverzeichnis,
  keine Seitenbereiche, keine Ueberschriftensuche noetig.
* Ueberschrift, Unterzeile, Vorspann und Autor stehen in eigenen kleinen
  Stories. Sie gehoeren zu dem Mengentext, den sie ankuendigen: auf derselben
  Seite, bei einem Aufmacher auch eine Seite davor.
* Kaesten und Zitate liegen ebenfalls einzeln; sie werden hinter dem letzten
  Absatz ihrer Seite eingefuegt, damit sie im Lesefluss an der richtigen
  Stelle stehen.
* Kurze Meldungen (Kalenderblatt, Nachrichtenspalte) tragen ihre Zeile als
  ersten Absatz der eigenen Story. Dann gilt das Format des ersten Absatzes.

Zwei Eigenheiten des Satzes kosten sonst Text:

* Ein Formatbereich (`ParagraphStyleRange`) umfasst **mehrere** Absaetze,
  getrennt durch `<Br/>`. Wer daraus einen Block macht, bekommt 150.000
  Zeichen in fuenf Kloetzen statt in hundert Absaetzen.
* Der **Anfangsbuchstabe** steht oft in einem eigenen Rahmen, damit er frei
  ueber mehrere Zeilen stehen kann. Dem Absatz fehlt er dann vorn
  ("ridolin Rudolf ..."). Er wird ueber die Lage auf der Seite
  zurueckgegeben.

### Schmuckflaechen sind keine Bilder

Der gelbe Klebezettel hinter einem Kasten, das Kalenderblatt hinter einem
Datum, das Fusszeilenlogo: im Satz sind das platzierte Bilder wie jedes Foto.
Im Artikel stand dann eine leere gelbe Flaeche.

Erkannt werden sie an der Anordnung, nicht am Aussehen: **im Bildrahmen steckt
ein Textrahmen.** Deckt dieser mindestens 30 Prozent des Bildes ab und traegt
er Beiwerk — Kasten, Kolumnentitel, Bildquelle, Rubrikname —, ist das Bild
seine Unterlage und faellt weg. Steht dagegen Mengentext oder eine Ueberschrift
darin, ist es ein Aufmacherfoto mit Text darauf und bleibt.

Ueber Helligkeit oder Farbe laesst sich das **nicht** entscheiden: das
flaechigste Bild im Heft Greim ist eine Landkarte, und die gehoert in den
Artikel. Gemessen an den vier Musterheften trifft die Regel 42 von 966
Bildrahmen, und zwar genau die Schmuckflaechen (Greim 22 Klebezettel, DMZ 170
16 Kalenderblaetter, DMZ-Zeitgeschichte ein Zierstern, ZUERST! 3 Logos).

Nachrechnen laesst sich das ohne Server und ohne Datenbank:

```bash
scripts/satz-lesen.py "<Heftordner>"              # Artikel mit Seiten und Laenge
scripts/satz-lesen.py "<Heftordner>" --artikel 1  # Volltext eines Artikels
scripts/satz-lesen.py "<Heftordner>" --stories    # Stories mit Rolle und Format
```

Gemessen an den vier Musterheften landen so 86 bis 92 Prozent aller Zeichen des
Satzes in Artikeln; der Rest sind Bildunterschriften, Bildquellen,
Kolumnentitel und das Inhaltsverzeichnis, die bewusst woanders hingehoeren.

Der letzte Schritt ist bewusst eine einzige Mutation: bei einem erneuten Import
sehen Leser entweder den alten oder den neuen Stand, nie eine Mischung.

Ein erneuter Lauf ersetzt auch redaktionelle Korrekturen an Artikeln, Bloecken,
Regionen und am automatisch erzeugten Inhaltsverzeichnis. Quellen, Stammdaten,
Kaeufe und Freischaltungen bleiben. Bei einer veroeffentlichten Ausgabe bleibt
der Seitenmodus durchgehend nutzbar; die Artikel stehen danach wieder auf
`pending` und muessen neu entschieden werden, bevor sie im Artikelmodus
erscheinen.

### Publikationsprofile

Die allgemeine Erkennung kennt kein Heft. Fuer Titel mit fester Heftstruktur
gibt es Profile in `extract-service/extractor/publication_profiles.py`; welches
greift, entscheidet die Kennung (`slug`) der Publikation:

| Kennung | Konvention |
|---|---|
| `zuerst` | Seite 3 Editorial, Seite 4 Inhalt, Rubriken als Versalien im Kolumnentitel; das Inhaltsverzeichnis liefert Artikelanker und Klickflaechen |
| `dmz` | Seite 3 Editorial, Seite 4 Inhalt in zwei Spalten (fette Seitenzahl, Rubrik 13 pt, Titel 11,5 pt); Kolumnentitel in Gross- und Kleinschreibung, 16 pt fett; Rubrikseiten wie Kalenderblatt, Nachrichten, Buchbesprechungen werden an ihren Ueberschriften getrennt |

Beide Profile entfernen Umschlag und Inhaltsseite aus dem Artikelmodus und
bauen Artikel entlang des gedruckten Inhaltsverzeichnisses. Ein Editorial, das
im Verzeichnis nicht steht, bekommt einen eigenen Eintrag ohne Klickflaeche.

### Was der Parser kann und was nicht

An den vier Musterheften, jeweils ueber die Satzdatei:

| Heft | Seiten | Artikel | Inhaltseintraege | Bildbereiche |
|---|---|---|---|---|
| ZUERST! 3/2026 | 81 | 70 | 46 | 158 |
| DMZ 170 | 81 | 53 | 25 | 223 |
| DMZ Zeitgeschichte 80 | 65 | 30 | 11 | 188 |
| Schwertertraeger 36 | 49 | 7 | 0 | 91 |

Nachmessen laesst sich das ohne Server:

```bash
extract-service/.venv/bin/python scripts/heft-pruefen.py "<Heftordner>"
scripts/heft-pruefen.py "<Heftordner>" --artikel 5     # Volltext eines Artikels
```

Nicht jede Grenze sitzt. Wo ein Artikel ueber mehrere Rahmen laeuft, schaetzt
der Import die Seitenaufteilung ueber die Rahmenflaeche — wo genau der Text
umbricht, entscheidet erst InDesign beim Setzen und steht in der IDML nicht.
Anfang und Ende eines Artikels stimmen dadurch, die Seiten dazwischen koennen
sich bei Nachbarartikeln ueberlappen. Dafuer gibt es die Pruefansicht.

Jeder Artikel bekommt ein `confidence`-Mass. Alles unter 0,8 ist ein Hinweis,
zuerst dort hinzuschauen.

### Was aus dem Heft selbst kommt

Zwei Angaben liest der Import aus dem Heft, damit sie niemand abtippen muss:

* **Einzelpreis** aus dem Impressum des Innenteils ("Einzelheft: 9,80"). Das
  ist Text und damit verlaesslich.
* **Erscheinungszeitraum** aus der Kopfzeile der Titelseite ("Nr. 170 ·
  Maerz-April 2026"). Die Titelseite ist ein Bild, dafuer laeuft eine
  Texterkennung (Tesseract). Fehlt sie im System, bleibt die Angabe leer.

Gesetzt wird nur, was am Heft noch nicht steht. Eine Eingabe der Redaktion
bleibt unangetastet. Die Heftnummer wird nicht aus dem Text gelesen — sie steht
im Ordnernamen, und dort steht sie eindeutig.

### Einstieg an der angetippten Seite

Ein Artikel laeuft ueber viele Seiten. Wer auf Seite 6 tippt, will dort
weiterlesen und nicht am Anfang landen. Jeder Absatz und jedes Bild traegt im
Reader seine Druckseite (`data-source-page`); beim Oeffnen springt die Ansicht
an die erste Marke dieser Seite. Auf der Anfangsseite des Artikels bleibt es
beim Kopf mit Titel und Unterzeile. Derselbe Einstieg gilt beim Wechsel vom
Seiten- in den Artikelmodus.

### Klickflaechen im Seitenmodus

Wer im Seitenmodus auf einen Artikel tippt, springt in den Artikelmodus. Die
Flaechen dafuer kommen aus dem Satz: **ein Textrahmen ist eine Flaeche**. Wo
genau ein einzelner Absatz im Rahmen sitzt, weiss die IDML nicht — der Rahmen
selbst steht dagegen fest, und er ist ohnehin die richtige Groesse zum Antippen.
Bilder zaehlen mit, damit man nicht nur den Text daneben treffen kann.

Sichtbar sind die Flaechen erst, wenn der Artikel freigegeben und die Ausgabe
veroeffentlicht ist. Zum Durchsehen eines frisch importierten Hefts gibt es in
der Pruefansicht den Knopf **Alle offenen freigeben**.

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

Die Tests am echten Heft laufen, wenn die Druckdateien im nicht eingecheckten
Ordner `hefte test/` im Wurzelverzeichnis des Repositories liegen (`zuerst 3-2026 innenteil.pdf`,
`umschlag zuerst 3-2026.pdf`, `dmz 170 innenteil.pdf`, `umschlag dmz 170.pdf`);
sonst werden sie uebersprungen.

## Heft auf der Kommandozeile anlegen

`scripts/heft-anlegen.py` laedt die Dateien in die Convex-Ablage, legt Titel,
Ausgabe, Quellen und Leserreihenfolge an, stellt den Importauftrag ein und
wartet auf den Worker. Fuer Produktion muss `CONVEX_DEPLOY_KEY` gesetzt sein
(Umgebung oder `.env.local`); ohne Key gilt das verknuepfte Dev-Deployment.

```bash
CONVEX_DEPLOY_KEY=... scripts/heft-anlegen.py \
  --publikation "Deutsche Militärzeitschrift" --kennung dmz \
  --titel "DMZ 170" --nummer 170 --preis 9,80 \
  --innen "hefte test/dmz 170 innenteil.pdf" \
  --umschlag "hefte test/umschlag dmz 170.pdf" --umschlag-layout spreads \
  --archiv "hefte test/dmz 170.indd" --archiv "hefte test/umschlag dmz 170.indd"
```

Danach steht die Ausgabe als Entwurf in der Redaktion; Pruefung und
Veroeffentlichung bleiben ein redaktioneller Schritt.
