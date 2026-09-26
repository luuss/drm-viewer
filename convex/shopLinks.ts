/**
 * Der Laden als Kaufweg: Adressen und Pruefungen ohne Convex-Bezug, damit
 * sie auch in `"use node"`-Dateien (billing.ts) und Tests nutzbar sind.
 */
import { SHOP_URL } from "./shopCovers";

/**
 * Eigener Stripe-Checkout im Leser. Verkauft wird im Laden; der Checkout
 * bleibt nur als Rueckweg im Code und ist ohne `STRIPE_CHECKOUT_ENABLED=true`
 * in der Convex-Umgebung aus — in der Oberflaeche wie in den Aktionen.
 */
export function stripeCheckoutEnabled(): boolean {
  return process.env.STRIPE_CHECKOUT_ENABLED === "true";
}

export function shopSearchUrl(term: string): string {
  const q = term.trim();
  return q ? `${SHOP_URL}/suche?s=${encodeURIComponent(q)}` : `${SHOP_URL}/`;
}

/** Kaufadresse eines Hefts: eingetragene Produktseite, sonst Suche nach dem Namen. */
export function issueShopLink(
  issue: { title: string; issueNumber?: string; shopTitle?: string; shopUrl?: string },
  publicationName: string | null,
): string {
  if (issue.shopUrl) return issue.shopUrl;
  const name = issue.shopTitle ?? issue.title;
  const withNumber =
    issue.issueNumber && !name.includes(issue.issueNumber)
      ? `${publicationName ?? name} ${issue.issueNumber}`
      : name;
  return shopSearchUrl(withNumber);
}

/** Kaufadresse des Digital-Abos einer Reihe. */
export function subscriptionShopLink(publication: {
  name: string;
  shopSubscriptionUrl?: string;
}): string {
  return publication.shopSubscriptionUrl ?? shopSearchUrl(publication.name);
}

/**
 * Adresse aus der Redaktion pruefen: leer heisst entfernen, sonst nur
 * http(s). Andere Schemata (`javascript:`) kaemen sonst in einen Link.
 */
export function cleanShopUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Keine gültige Adresse: ${text}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Nur http- und https-Adressen sind erlaubt");
  }
  return url.toString();
}

/** Artikelnummer aus der Redaktion: leer heisst entfernen. */
export function cleanSku(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (text.length > 200) throw new Error("Artikelnummer zu lang");
  return text;
}
