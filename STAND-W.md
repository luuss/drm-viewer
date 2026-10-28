# Stand Nachbesserungen (gegnerische Pruefung), 28.10.2026

Branch `worktree-agent-ac23cd154c17449fd`, auf origin/claude/digital (d218cfd) aufgesetzt.

Erledigt (je mit Test und eigenem Commit):
1. Kachel-Ladeketten abbrechen, check_rate vor require_ticket: baa7d2a
2. Gateway-Zwischenspeicher nach Stand (assets.updatedAt, assetStand) und 5 min: 887801d
   (Convex-Schema-Erweiterung, Convex und Gateway zusammen ausrollen)
3. Bildkennung vor Convex pruefen, Merkliste fester Groesse: 53f26ff
4. Wischgeste nur auf dem Lesetext (wischbar): 424a040

Offen:
5. fundstelle nur sichtbare Bloecke (Doppelt-Regel wie getForReader), Absaetze bevorzugen
6. limit serverseitig auf 100 deckeln, Lesebudget fuer fundstelle; SearchPage: Limit an Begriff
   koppeln statt im Effekt zuruecksetzen; Fangnetz um SearchPage
7. nenntMonat: ganze Monatsnamen mit Wortgrenzen, "3/26" richtig
8. searchCatalog: rang nicht ausliefern
9. istUmschlag: Index 0 nur ohne bekannte Rolle

Tests zuletzt: vitest (web+convex) und tile-service pytest gruen nach Punkt 4.
