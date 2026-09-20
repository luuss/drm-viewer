/**
 * Authentifizierung der internen Dienste (Kachel- und Extraktionsdienst).
 *
 * Die Dienste sprechen nicht mehr die oeffentliche Convex-Query-Schnittstelle
 * an, sondern eigene HTTP-Endpunkte. Das Geheimnis steht im Header und wird in
 * konstanter Zeit verglichen. Beide Dienste haben getrennte Geheimnisse, damit
 * ein uebernommener Kacheldienst keine Artikel einschleusen kann.
 */

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Laengenunterschied ebenfalls ohne fruehen Ausstieg behandeln.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function checkTileSecret(header: string | null): boolean {
  const expected = process.env.TILE_SERVICE_SECRET;
  if (!expected || !header) return false;
  return timingSafeEqual(header, expected);
}

export function checkExtractSecret(header: string | null): boolean {
  // Getrenntes Geheimnis; ohne eigenes faellt es auf das des Kacheldienstes
  // zurueck, damit bestehende Installationen weiterlaufen.
  const expected =
    process.env.EXTRACT_SERVICE_SECRET ?? process.env.TILE_SERVICE_SECRET;
  if (!expected || !header) return false;
  return timingSafeEqual(header, expected);
}
