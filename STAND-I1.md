# Stand Umsetzer i1 (Bilder, Anzeigen, Unterschriften) — 28.10.2026

Branch `worktree-agent-a938c220085c6e63a`, aufgesetzt auf `claude/digital` (6da0fd5).
Letzter Pruefstandslauf: `i1-g` (Vergleich gegen `i1-start`).

## Erledigt (Code, im Pruefstand geprueft, noch ohne eigene Tests)

Neues Modul `extract-service/extractor/satzbilder.py`, aufgerufen in
`worker._from_idml` (`bilder_im_satz`), verteilt in `idml_articles.artikel_aus_satz`
(`bilder_verteilen` statt `_attach_images`).

* D/C Bildunterschriften aus ihrer Story (innen/unter/ueber/neben, alle Absaetze
  verbunden, Leerzeile trennt Unterschriften zweier Bilder, Kasten mit Bild,
  inneres Bild vor Hintergrund, gemeinsame Unterschrift zweier Bilder).
  `SourceBlock.absatzgruppe` (idml_extract). Summe 571 -> 1182 Bilder mit
  Unterschrift; "Szenario 2/3" (3/2025) nicht mehr unter fremden Bildern.
* E Schmuck: Datei auf >=3 Seiten, Schriftzug-Rahmen (>=3 Teilpfade,
  `IdmlImageFrame.teilpfade`), freigestellter Ausschnitt ueber eigenem
  Hintergrund, Streifen >=4:1 ohne Unterschrift/Nachweis, Unterschrift unter
  Grussformel, Stoerer ("NEU!"). DMZ "Putins Weltuntergangswaffe" bleibt (echtes
  Foto mit Unterschrift).
* A Anzeigen: Kennzeichnung "Anzeige", platziertes PDF ohne Beleg, Buchanzeigen
  (auch Preis in eigenem Rahmen), Gruppen kurzer Texte mit Preis+Anschrift bzw.
  Webadressen (Eigenwerbung "Zuletzt": Text und Bilder weg). Redaktionelle Fotos
  nie an Anzeigen, Anzeigenbilder nie in Artikel. Zuordnung Bild->Story ueber
  alle Textrahmen (kleinster umschliessender Rahmen, Spalte, Zeile, Bildseite
  innerhalb der Rahmenkette). Autor "Was die Deutschen nicht wissen sollen"
  (3/2026) faellt so ebenfalls weg. `idml_articles._UMFANG` erkennt "432 S. €".
* B Buchseiten: Cover je Anzeige ueber Spalte/Zeile/Dateiname (alle ZUERST!
  S. 79, DMZ S. 59 inkl. eigener "Panther II"-Eintrag, 3/2026 "ALT!" ohne Cover).
* F Klickflaechen: eine Flaeche je Anzeige (Text+Cover), Bild-Anreisser im
  gedruckten Verzeichnis -> Artikel (worker `_teaserflaechen`).
* G Buchflaechen: "Autor: Titel" wird getrennt, Suche nach dem Titel
  (buecher.py; Test ZG "Soldatenköpfe" angepasst).

pytest: 195 passed (Stand vor neuen Tests).

## Halb fertig / offen

* Tests fuer satzbilder fehlen noch. Vorbereitet: `tools/satz_fixture.py`
  (schreibt Seitenausschnitte als JSON). Geplante Vorlagen: 3/2025 S.12-14,18,27,38;
  6/2025 S.2,8,10,20,72; 1/2025 S.64,81; 3/2026 S.14,78; DMZ 170 S.13,16,17,37,58;
  5/2025 S.66,74; Greim S.14,43,49; ZG 80 S.15,16,28,47,48,62. Je Regel "greift"
  und "greift nicht" (anderes Heft derselben Reihe).
* Commits thematisch aufteilen (jetzt ein WIP-Commit).
* Nicht angefasst (Titellogik, anderer Umsetzer): 4/2025 Ueberschrift eine Seite
  vor dem Text (#4), Titel "ALT!" fuer die Rezension.

## Naechste Schritte

1. Vorlagen erzeugen, Tests schreiben, `pytest -q` gruen.
2. Pruefstand ueber alle Hefte gegen `i1-start`, Ergebnisse wie oben pruefen.
3. Commits trennen: Unterschriften / Schmuck / Anzeigen+Zuordnung / Klickflaechen / Shop-Suche.
