/**
 * Netzformat eines Druck-PDF ohne Satzdatei pruefen.
 *
 * Mit IDML kommt das Netzformat aus dem Satz. Ohne sie nennt es die TrimBox
 * des PDF. Fehlte beides, kamen die Seiten mit Anschnitt und Schnittmarken in
 * den Leser (300 Weltkrieg-Hefte, 05.11.2026). Die TrimBox gilt nur, wenn sie
 * kleiner ist als die Seite und hoechstens ein Fuenftel abschneidet; sonst
 * stimmt etwas nicht, und es wird nicht geschnitten. Der Worker prueft die
 * Seitenbilder danach ohnehin auf Schnittmarken (extract-service/extractor/
 * schnittmarken.py).
 */
export type Netzformat = { breitePt: number; hoehePt: number };

export function netzformatPruefen(
  seiteBreitePt: number,
  seiteHoehePt: number,
  trim: Netzformat | undefined,
): Netzformat | undefined {
  if (!trim || !(seiteBreitePt > 0) || !(seiteHoehePt > 0)) return undefined;
  const b = trim.breitePt / seiteBreitePt;
  const h = trim.hoehePt / seiteHoehePt;
  // Gleich gross: nichts zu schneiden.
  if (b >= 0.999 && h >= 0.999) return undefined;
  // Groesser als die Seite oder mehr als ein Fuenftel weg: unplausibel.
  if (b > 1.001 || h > 1.001 || b < 0.8 || h < 0.8) return undefined;
  return trim;
}
