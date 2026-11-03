/**
 * Was der Leser gerade sehen will, geht vor.
 *
 * Kacheln und Bilder, die der Reader zum Anzeigen holt, zaehlen hier mit.
 * Das Fuellen des Offline-Puffers (`pufferFuellen.ts`) wartet, solange
 * welche laufen; sonst stuende es mit dem Leser in derselben Schlange am
 * Gateway, und das Blaettern wuerde langsamer.
 */
let laufend = 0;

/** Eine Anfrage fuer die Anzeige; solange sie laeuft, haelt das Fuellen an. */
export function liveAnfrage<T>(anfrage: Promise<T>): Promise<T> {
  laufend += 1;
  return anfrage.finally(() => {
    laufend -= 1;
  });
}

export function liveLaeuft(): boolean {
  return laufend > 0;
}
