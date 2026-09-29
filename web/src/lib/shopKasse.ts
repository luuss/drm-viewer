/**
 * Sprung in die Kasse des Ladens fuer Zahlarten, die es nur dort gibt
 * (Rechnung, Vorkasse, SEPA), oder solange der Kartenkauf im Leser aus ist.
 * `lusdigital/warenkorb` legt die Hefte in den Warenkorb des Ladens und
 * oeffnet die Kasse. Die E-Mail des Leser-Kontos wird dort vorbelegt, weil die
 * Freischaltung an ihr haengt.
 */
export function kassenUrl(shopUrl: string, skus: string[], email?: string | null): string {
  const url = new URL("module/lusdigital/warenkorb", shopUrl.endsWith("/") ? shopUrl : `${shopUrl}/`);
  url.searchParams.set("artikel", skus.join(","));
  if (email) url.searchParams.set("email", email);
  return url.toString();
}
