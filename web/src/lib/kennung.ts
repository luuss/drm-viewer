/**
 * Sieht der Text aus wie eine Convex-Kennung? Kennungen sind 31 bis 37
 * Zeichen Crockford-Base32 (ohne i, l, o, u). Eine kaputte Kennung in der
 * Adresse ging sonst ungeprueft an Convex, die Abfrage scheiterte mit
 * ArgumentValidationError, und der Leser blieb leer. Ob die Kennung zur
 * richtigen Tabelle gehoert, weiss erst der Server; dafuer faengt
 * `Fangnetz` den Fehler ab.
 */
export function istKennung(text: string | undefined): text is string {
  return !!text && /^[0-9a-hjkmnp-tv-z]{31,37}$/.test(text);
}

/** Scheiterte eine Abfrage an einer Kennung, die es so nicht gibt? */
export function istKennungsfehler(fehler: unknown): boolean {
  const text = fehler instanceof Error ? fehler.message : String(fehler ?? "");
  return /ArgumentValidationError|does not match validator|Invalid argument/i.test(text);
}
