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

/** Wohin eine fertige Geste blaettert; nach rechts gewischt heisst zurueck. */
export function wischziel(dx: number, dy: number): "zurueck" | "weiter" | null {
  if (Math.abs(dx) <= BLAETTERN || Math.abs(dx) <= Math.abs(dy) * VORRANG) return null;
  return dx > 0 ? "zurueck" : "weiter";
}
