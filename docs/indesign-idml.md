# Der Weg aus InDesign: IDML, nicht INDD

Der Leseweg soll den Satz auswerten und nicht nur das fertige PDF, weil im Satz
steht, was zusammengehoert: eine Story laeuft ueber alle verketteten Rahmen,
jeder Absatz traegt sein Format, jeder Bildrahmen seine Koordinaten. Aus dem PDF
muss all das erraten werden.

Ausgewertet wird dafuer die **IDML**, der Austauschexport aus InDesign. Die
**INDD** wird abgelegt, aber nicht gelesen. Dieser Text sagt, warum.

## Warum die INDD nicht gelesen wird

Die `.indd` ist ein binaerer Objektspeicher, kein Zip und kein XML. Adobe hat das
Format nie veroeffentlicht, und es gibt bis heute keine freie Bibliothek, die es
liest — weder in Python noch in Go oder TypeScript. Alle setzen die IDML voraus.
Das einzige Programm, das die INDD selbst liest, ist Photopea (weiter unten).

Am Musterheft (`hefte test/zuerst 3-2026.indd`, 66 MB) wurde das nachgemessen,
damit die Aussage nicht auf Zuruf beruht:

- Kein eingebettetes IDML, kein Zip-Anteil: `idPkg`, `ParagraphStyleRange`,
  `<Story` und `PK\x03\x04` kommen kein einziges Mal in der Datei vor.
- Text liegt als Folge kurzer Saetze vor, jeweils `[Laenge][@][UTF-8]`, mit `\r`
  als Absatzende. Roh eingesammelt sind das rund 288.000 Zeichen.
- Die Saetze sind aber Bruchstuecke des Bearbeitungsspeichers, nicht der
  gesetzte Fliesstext. Aneinandergereiht ergeben sie zerrissene Saetze
  ("Schon auf der Kndern auch gegen Vorschriften ..."), und die Datei haelt
  zusaetzlich einen zweiten, aelteren Stand des gesamten Dokuments.
- Der Satzstrom hat zwar erkennbar feste Kopfsaetze mit laufender Nummer,
  Klassen- und Objektkennung — sauber durchketten liess er sich in der Sondierung
  nicht. Wer die Stories in Reihenfolge und mit Formatbezug rekonstruieren will,
  muss den Objektgraphen der INDD nachbauen. Das ist ein eigenes Vorhaben mit
  offenem Ausgang, kein Nachmittag.

Ergebnis: mit eigenen Mitteln ist aus der INDD nichts zu holen, was besser waere
als das, was schon aus dem PDF kommt.

## Der eine Notnagel: Photopea

Ausser InDesign liest genau ein Programm das Binaerformat: **Photopea**, kostenlos
und im Browser. Seit Version 5.3 oeffnet es eine `.indd` als Ebenendokument mit
echtem Text, Vektoren und Bildern; jede Heftseite wird ein Artboard, jeder
Textrahmen eine Textebene mit Inhalt und Koordinaten. Der Importer ist
proprietaer und wird von photopea.com geladen — die Datei selbst bleibt im
Browser, der Code kommt von aussen.

Darauf setzt [dorukgezici/indd-to-idml](https://github.com/dorukgezici/indd-to-idml)
(MIT, Python): es faehrt Photopea in einem kopflosen Browser, holt das Ergebnis
als PSD und schreibt daraus selbst eine IDML. Die Forschungsnotiz des Projekts
ist ehrlich — eine bearbeitbare Rekonstruktion, kein verlustfreier Export,
geprueft an drei Dokumenten. Das Projekt ist jung und ungenutzt.

Fuer uns waere ohnehin nicht die IDML das Ziel, sondern der `SourceBlock`: Text,
Position, Seite. Die lassen sich aus den Photopea-Ebenen direkt lesen, ohne den
Umweg ueber ein Austauschformat.

Angesehen habe ich mir den Weg am Umschlag des Musterheftes, mit kopflosem
Chromium gegen photopea.com. Zwei Dinge sind dabei belegt, ein drittes nicht:

- Der Import beginnt wirklich. Photopea zieht die `.indd` vom lokalen Server und
  dekodiert die eingebetteten Bilder; das steht so in seiner Protokollausgabe.
- Chrome sperrt den Zugriff zuerst ab: eine Seite von `https://www.photopea.com`
  darf nicht ohne Weiteres auf `127.0.0.1` zugreifen. Der lokale Server muss
  `Access-Control-Allow-Private-Network` mitschicken und die Vorabfrage
  beantworten.
- Fernsteuern liess sich Photopea nicht. Seine Live-Messaging-Schnittstelle gab
  weder auf Skripte noch beim Laden ein Lebenszeichen zurueck — auch nicht im
  iframe, auch nicht ohne jede Datei. Das ist ein Fehler in meiner Verdrahtung,
  kein Beweis gegen den Weg; das oben genannte Projekt macht genau das
  erfolgreich. Wer es aufgreift, faengt dort an.

Solange der Verlag den IDML-Export liefert, bleibt der Weg ungebaut. Er haengt an
einem fremden Dienst, dessen Importtreue niemand zusichert, und der Umschlag mit
vier Seiten war nach zwanzig Minuten noch nicht fertig — fuer achtzig Seiten
Innenteil ist das keine Grundlage.

## Welche Bibliotheken es gibt, und warum keine eingebaut ist

| Werkzeug | Was es kann | Warum nicht |
|---|---|---|
| [SimpleIDML](https://github.com/Starou/SimpleIDML) (Python) | Liest IDML eigenstaendig: `story_ids`, `stories`, `spreads_objects`, `pages`, `style_mapping`. Sein Schwerpunkt ist aber das Zusammensetzen von Dokumenten aus Bausteinen; die mitgelieferten Skripte sprechen den InDesign Server an. | Geprueft an einer erzeugten IDML: liefert Dateinamen und den DOM. Den Absatzdurchlauf mit Format und Text schreibt man danach trotzdem selbst — also genau das, was `idml_extract.py` schon tut. Eine Abhaengigkeit ohne Gewinn. |
| [idml2docbook](https://pypi.org/project/idml2docbook/) (Python) | Wandelt IDML nach DocBook. | Braucht Java und einen Git-Klon der XSLT-Strecke `idml2xml-frontend`. Das Ergebnis muesste erneut geparst werden. Schwere Fracht fuer den Worker-Container, ohne dass am Ende mehr herauskaeme. |
| [idml-json-converter](https://github.com/BitAndBlack/idml-json-converter) (PHP) | IDML nach JSON und zurueck. | Andere Sprache als der Dienst, gleiches Bild: die Auswertung bleibt unsere. |
| IDMarkz / MarkzPortal, Adobe InDesign Server, Typefi | Wandeln INDD nach IDML ohne Handarbeit. | Kosten Geld und laufen ausserhalb. Erst interessant, wenn der Verlag den Export dauerhaft nicht liefern kann. |

Die Auswertung bleibt deshalb in `extract-service/extractor/idml_extract.py`:
lxml ueber das Zip, ohne weitere Abhaengigkeit.

## Was der Verlag tun muss

Einmal pro Heft, in InDesign: **Datei → Exportieren → InDesign Markup (IDML)**,
die `.idml` neben die `.indd` legen und mit hochladen.

Fuer mehrere Dateien liegt `tools/indd-nach-idml.jsx` bereit. In InDesign unter
Fenster → Hilfsprogramme → Skripte oeffnen, doppelklicken, Ordner waehlen: das
Skript arbeitet den Ordner samt Unterordnern ab, legt jede `.idml` neben ihre
`.indd`, ueberspringt bereits vorhandene und schliesst ohne zu speichern.

## Stand der Auswertung

`idml_extract.py` liest Stories mit Absatzformat sowie Bildrahmen aus den
Spreads. Geprueft ist das bisher nur gegen `extract-service/tests/idml_fixture.py`.
Sobald ein echter Export vorliegt, ist am Heft zu pruefen: Gruppen, gedrehte
Rahmen, Rahmen auf Musterseiten und ob die Seitenzaehlung des Exports der
Seitenfolge des Innenteil-PDFs entspricht. Das steht als `drm-viewer-9oy` offen.
