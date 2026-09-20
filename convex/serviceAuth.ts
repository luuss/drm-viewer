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

/**
 * Signatur des externen Shops pruefen: HMAC-SHA256 ueber den rohen Rumpf mit
 * dem gemeinsamen Geheimnis, hexadezimal. Ohne gesetztes Geheimnis ist die
 * Schnittstelle zu.
 */
export async function checkShopSignature(
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  const secret = process.env.SHOP_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(signature.trim().toLowerCase(), expected);
}
