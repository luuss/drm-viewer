# Werkzeuge Weltkrieg-Leser

* `wkrun.sh [--identity JSON] funktion JSON` — `npx convex run` gegen die
  Anlage `wkdigital` (ruft `/root/wkrun` auf dem Server auf).
* `preise_setzen.sh` — Einzelpreis aller Hefte ohne Preis von der Titelseite
  (`textebene-umschlag.json`, Tafel `front_cover`): groesster "€ x,xx", sonst
  hochkant "Deutschland € x,xx"; Euro-Zeichen ist in manchen Schriften "t".
  Ohne Preis auf dem Umschlag (E-Book-Fassungen "ohne Preis") gilt der Preis
  des neuesten Hefts derselben Reihe. Aendert nur Daten, startet nichts neu.
  Identitaet: Testkonto `import-test@weltkrieg-online.de`.
