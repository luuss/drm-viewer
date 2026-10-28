# Stand Umsetzer i2 (Import-Titel/Kopf/Verzeichnis), 28.10.2026

Branch `worktree-agent-ad2be954a71cd574c` (auf claude/digital 6da0fd5 vorgespult).
Letzter Pruefstand-Lauf: `i2-e3` (Grundlauf `i2-start`). Pytest: 220 gruen.

## Erledigt (committet, mit Tests in tests/test_satz_kopf.py, test_idml_articles.py)
- Initialen DMZ 170 (21 Artikel): `initialen_zurueck` vor `mark_furniture`.
- A/G: Kopfzuordnung nach Guete, Karten-/Grafikbeschriftung (Rolle `grafik`,
  >=3 kurze Rahmen im Bild, "Text in der Karte"), Verzeichnis zuerst ueber Titel
  (4/2025 Feindbild Euro usw. richtig; "Leserbriefe/Impressum" in 9 Heften verknuepft,
  verzeichnis_ohne_artikel 10 -> 0).
- C: Unterzeile aus kurzem Einleitungstext (Untertitel 33 -> 368), langer Vorspann als lead.
- B: Autor aus eigenem Text, nie Anzeigenformat; Preis/Schlagzeile zur Anzeige.
- D: mehrzeilige Zeilen, 2 Meldungen in einer Story getrennt, Editorial-Anrede,
  Buchbesprechung "Verfasser: Titel", Kolumne Titelrahmen + Verfasser aus Verzeichnis,
  Buchanzeigen Verfasser/Titel/Untertitel.

## Im WIP-Commit (gelaufen in i2-e3, Diffs geprueft, Tests fehlen noch)
- E: Kasten-Story = ein box-Block mit "\n" (DMZ-Datenkaesten); Interviewfragen als
  Blocktyp `question` (convex/schema.ts blockType ergaenzt; tsc/vitest NICHT gelaufen);
  Vita-Kasten ans Interviewende; flow_text_blocks laesst reine Satzartikel in Reihenfolge.
- F: `leserbriefe_gliedern`: Bezug+Titel als ein subheading, Unterschrift eigener Absatz
  (auch angeklebte "… nachziehen. Holger Dörr").

## Naechste Schritte
- Tests fuer E/F (greift / greift nicht), Diff i2-e3 gegen i2-d fuer Z7/25..Z3/26, DMZ, ZG pruefen.
- `npx tsc --noEmit -p convex` und `npx vitest run`; Leser muss `question` darstellen (web/ nicht angefasst).
- Greim: Zitatkasten-Dubletten (Vergleich ohne Schlusspunkt in worker._ohne_kopfzeilen).
- Offen: DMZ 170 Selbstdarstellung S. 3 als eigener Artikel; 3/2026 "ALT!"-Sammelartikel.
