# Werkzeuge Weltkrieg-Leser

* `wkrun.sh [--identity JSON] funktion JSON` — `npx convex run` gegen die
  Anlage `wkdigital` (ruft `/root/wkrun` auf dem Server auf).
* `preise_setzen.sh` — Einzelpreis aller Hefte ohne Preis von der Titelseite
  (`textebene-umschlag.json`, Tafel `front_cover`): groesster "€ x,xx", sonst
  hochkant "Deutschland € x,xx"; Euro-Zeichen ist in manchen Schriften "t".
  Ohne Preis auf dem Umschlag (E-Book-Fassungen "ohne Preis") gilt der Preis
  des neuesten Hefts derselben Reihe. Aendert nur Daten, startet nichts neu.
  Identitaet: Testkonto `import-test@weltkrieg-online.de`.
* `fehlende_hefte.py` — Soll/Ist: Archiv-Hefte gegen Leser, schreibt
  `docs/weltkrieg-fehlende-hefte.md` (fehlend je Reihe mit Archivpfad,
  unvollständige Hefte, Hefte nur als INDD). Vorher die Archiv-Hefte aus der
  Ordnerliste erzeugen:
  `ARCHIV_LISTE=_scratch/wk-struktur/liste.json ARCHIV_AUS=_scratch/wk-struktur/archiv-hefte.json npx vitest run web/src/admin/heftarchiv.liste.test.ts`
