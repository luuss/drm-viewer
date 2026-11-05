/**
 * Der Laden der Anlage: welche Software, unter welcher Adresse.
 *
 * Lesen und Schenken (Standard): PrestaShop auf lesenundschenken.de mit dem
 * Modul lusdigital. Weltkrieg: WooCommerce auf weltkrieg-online.de mit dem
 * mu-plugin wk-digital (deploy/weltkrieg/wk-digital.php); dort
 * `LADEN=woocommerce` und `SHOP_BASIS_URL` in der Convex-Umgebung
 * (docker-compose.weltkrieg.yml, scripts/convex-env-sichern.mjs).
 *
 * Bis 05.11.2026 stand lesenundschenken.de fest im Code: "Im Netzladen
 * kaufen" fuehrte im Weltkrieg-Leser auf die Suche von Lesen und Schenken.
 */

export type LadenArt = "prestashop" | "woocommerce";

export function ladenArt(): LadenArt {
  return process.env.LADEN === "woocommerce" ? "woocommerce" : "prestashop";
}

/** Startseite des Ladens, ohne Schraegstrich am Ende. */
export function ladenUrl(): string {
  return (process.env.SHOP_BASIS_URL || "https://lesenundschenken.de").replace(/\/+$/, "");
}

/** Die Suchseite des Ladens mit einem Suchbegriff. */
export function ladenSuche(begriff: string): string {
  const q = encodeURIComponent(begriff.trim());
  if (!q) return `${ladenUrl()}/`;
  return ladenArt() === "woocommerce"
    ? `${ladenUrl()}/?s=${q}&post_type=product`
    : `${ladenUrl()}/suche?s=${q}`;
}

/** Produktseite nach Kennung, wenn der Laden keine Adresse mitliefert. */
export function ladenProdukt(id: number | string): string {
  return ladenArt() === "woocommerce"
    ? `${ladenUrl()}/?post_type=product&p=${id}`
    : `${ladenUrl()}/index.php?controller=product&id_product=${id}`;
}

/**
 * Wohin der Warenkorb des Lesers springt: die Seite des Ladens, die die
 * Artikelnummern (`artikel`) in den Warenkorb legt und in die Kasse fuehrt.
 */
export function ladenWarenkorb(): string {
  return ladenArt() === "woocommerce"
    ? `${ladenUrl()}/?wkdigital-warenkorb=1`
    : `${ladenUrl()}/module/lusdigital/warenkorb`;
}
