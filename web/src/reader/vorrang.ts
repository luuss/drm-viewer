/**
 * Was der Leser gerade sehen will, geht vor.
 *
 * Kacheln und Bilder, die der Reader zum Anzeigen holt, zaehlen hier mit.
 * Das Fuellen des Offline-Puffers (`pufferFuellen.ts`) wartet, solange
 * welche laufen, und noch einen Moment danach: beim Blaettern kommen die
 * Kacheln einer Seite in Schueben, und dazwischen soll das Fuellen dem
 * Gateway nicht neue Arbeit geben. Gemessen am 03.11.2026: ohne diese Pause
 * stand eine frisch aufgeschlagene Seite bis zu einer halben Sekunde spaeter.
 */
let laufend = 0;
let zuletzt = -Infinity;

/** So lange nach der letzten Anzeige-Anfrage bleibt das Fuellen noch still. */
export const NACHLAUF_MS = 1500;

/** Eine Anfrage fuer die Anzeige; solange sie laeuft, haelt das Fuellen an. */
export function liveAnfrage<T>(anfrage: Promise<T>): Promise<T> {
  laufend += 1;
  zuletzt = Date.now();
  return anfrage.finally(() => {
    laufend -= 1;
    zuletzt = Date.now();
  });
}

export function liveLaeuft(jetzt = Date.now()): boolean {
  return laufend > 0 || jetzt - zuletzt < NACHLAUF_MS;
}
