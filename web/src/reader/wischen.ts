// Kuerzere Bewegungen sind Zittern, keine Richtung.
const SCHWELLE = 10;
// So viel weiter muss es zur Seite gehen als nach oben oder unten.
const VORRANG = 1.5;
// Mindestweg zur Seite, bis geblaettert wird.
const BLAETTERN = 60;

export type Wischachse = "quer" | "hoch";

/**
 * Achse einer Wischgeste im Artikelmodus, null solange sie noch nicht klar
 * ist. Einmal "quer", gehoert die Geste dem Leser: sonst nimmt Chromium sie
 * als Zurueck-Geste und der Leser landet in der Bibliothek.
 */
export function wischachse(dx: number, dy: number): Wischachse | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SCHWELLE) return null;
  return Math.abs(dx) > Math.abs(dy) * VORRANG ? "quer" : "hoch";
}

/** Bedienelemente: dort gehoert eine Bewegung ihnen, nicht dem Blaettern. */
const BEDIENUNG =
  "button, a, input, select, textarea, label, summary, [role='slider'], [role='dialog'], [contenteditable='true']";

/** Was `wischbar` von einem Element braucht (im Test ohne DOM nachgebaut). */
type Ziel = { closest(selector: string): { scrollWidth: number; clientWidth: number } | null };

/**
 * Darf eine Beruehrung hier zum Blaettern werden? Nur auf dem Lesetext
 * selbst. Leiste und Regler unten, Kopfleiste, Inhaltsverzeichnis und jedes
 * Bedienelement sind ausgenommen: ein Zug am Regler blaetterte sonst nach dem
 * Sprung noch einen Artikel weiter. Eine Tabelle, die seitlich rollt, auch.
 */
export function wischbar(ziel: Ziel | null): boolean {
  if (!ziel || !ziel.closest(".article-mode")) return false;
  if (ziel.closest(BEDIENUNG)) return false;
  const tabelle = ziel.closest(".article-table");
  return !(tabelle && tabelle.scrollWidth > tabelle.clientWidth);
}

/** Wohin eine fertige Geste blaettert; nach rechts gewischt heisst zurueck. */
export function wischziel(dx: number, dy: number): "zurueck" | "weiter" | null {
  if (Math.abs(dx) <= BLAETTERN || Math.abs(dx) <= Math.abs(dy) * VORRANG) return null;
  return dx > 0 ? "zurueck" : "weiter";
}
