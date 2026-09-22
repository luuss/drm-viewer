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
3. Text mit pdfplumber lesen: Position, Schriftgroesse, Schriftart.
4. Beiwerk aussortieren: Seitenzahlen, Kolumnentitel, Setzer-Slug, Ueberdruck.
5. Spalten bestimmen und Lesereihenfolge herstellen.
6. IDML auswerten, falls vorhanden.
7. Artikel bauen, Bilder zuschneiden.
8. Ergebnis in einer Transaktion aktivieren.

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

Am Musterheft ZUERST! 3/2026 (84 Seiten) entstehen rund 60 bis 75 Artikel mit
sauberen Ueberschriften und zusammenhaengendem Fliesstext ueber Seitengrenzen.
Am Musterheft DMZ 170 (84 Seiten, A4) sind es rund 43 Artikel: 25 Eintraege
des Inhaltsverzeichnisses plus Editorial, dazu die Einzelmeldungen der
Rubrikseiten. Nicht jede Grenze sitzt: bei Bildstrecken und Kaesten trennt die
Automatik gelegentlich zu fein. Dafuer gibt es die Pruefansicht.

Jeder Artikel bekommt ein `confidence`-Mass. Alles unter 0,8 ist ein Hinweis,
zuerst dort hinzuschauen.

### KI-Stufe

Optional kann ein Sprachmodell die Gruppierung nachbessern. Es ist
**standardmaessig aus**. Der Import-Worker sendet jeweils hoechstens zwei
gerenderte Druckseiten sowie vollstaendige Zeilen-, Geometrie- und Bild-IDs an
ein Vision-Modell. Die Antwort darf nur vorhandene IDs ordnen: Absaetze,
Lesereihenfolge, Rollen, Bildunterschriften und Bild-zu-Artikel-Zuordnung. Der
Text wird lokal aus den PDF-Zeilen rekonstruiert; unbekannte, doppelte oder
ausgelassene IDs verwerfen den ganzen Seiten-Chunk und nutzen automatisch das
deterministische Ergebnis.

Aktivierung im **Secret-Store des Import-Workers** (nicht in Convex-Daten und
nicht im Frontend):

```dotenv
EXTRACT_USE_LLM=true
EXTRACT_LLM_PROVIDER=anthropic   # oder openai/openrouter
EXTRACT_LLM_MODEL=<Vision-Modell>
EXTRACT_LLM_API_KEY=<geheim>
```

Bei OpenRouter lassen sich Provider und Datenschutz pro Request hart begrenzen:

```dotenv
EXTRACT_LLM_ROUTING_ONLY=together
EXTRACT_LLM_ZDR=true
EXTRACT_LLM_DATA_COLLECTION=deny
EXTRACT_LLM_ALLOW_FALLBACKS=false
```

Damit wird nicht auf einen anderen Endpoint ausgewichen, falls Together die
angeforderten Datenschutzbedingungen oder das Modell gerade nicht anbieten
kann. Der betroffene Chunk nutzt dann das deterministische Ergebnis.

Ein mit `npx convex env set` gesetzter Provider-Key ist fuer den separaten
Worker nicht sichtbar. Er gehoert deshalb in dessen Deployment-Secrets bzw. in
die nicht eingecheckte `.env.selfhost`.

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
