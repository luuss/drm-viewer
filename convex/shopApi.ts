/**
 * Client fuer die Schnittstelle des Ladenmoduls `lusdigital` im PrestaShop.
 *
 * Der Leser ordnet ein Heft dem Druckheft im Laden zu und legt dort die
 * Digital-Variante an. Jeder Aufruf ist ein POST mit JSON-Rumpf
 * `{ action, ts, ...Parameter }`, signiert wie die Gegenrichtung
 * (`checkShopSignature`): HMAC-SHA256 ueber den rohen Rumpf mit
 * `SHOP_WEBHOOK_SECRET`, hexadezimal im Header `x-shop-signature`. `ts` in
 * Unix-Sekunden erlaubt dem Modul, alte Aufrufe abzulehnen.
 *
 * Reine Funktionen ohne Convex-Bezug; `fetch` ist austauschbar, damit sich
 * Signatur und Antwortverarbeitung ohne Laden testen lassen. Fehler sind
 * deutsche Saetze fuer die Redaktion.
 */
import {
  SHOP_URL,
  designationMatches,
  searchQueryForIssue,
  seriesFor,
} from "./shopCovers";

export const DEFAULT_SHOP_API_URL = `${SHOP_URL}/module/lusdigital/api`;
const TIMEOUT_MS = 15_000;

export type ShopAction = "search" | "product" | "offer_digital" | "withdraw_digital";

export type ShopDigital = {
  idProductAttribute: number;
  sku: string;
  priceCents: number | null;
  available: boolean;
};

export type ShopProduct = {
  id: number;
  name: string;
  reference: string;
  priceCents: number | null;
  url: string;
  coverUrl: string | null;
  manufacturer: string;
  active: boolean;
  digital: ShopDigital | null;
};

export class ShopApiError extends Error {}

export async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type CallOptions = {
  fetch?: typeof fetch;
  url?: string;
  secret?: string;
  now?: () => number;
};

/** Einen Aufruf absetzen; liefert die Antwort mit `ok: true` oder wirft. */
export async function callShopApi(
  action: ShopAction,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<Record<string, any>> {
  const secret = opts.secret ?? process.env.SHOP_WEBHOOK_SECRET;
  if (!secret) {
    throw new ShopApiError(
      "SHOP_WEBHOOK_SECRET ist nicht gesetzt. Ohne das gemeinsame Geheimnis spricht der Leser nicht mit dem Shop.",
    );
  }
  const url = opts.url ?? process.env.SHOP_API_URL ?? DEFAULT_SHOP_API_URL;
  const ts = Math.floor((opts.now ?? Date.now)() / 1000);
  const body = JSON.stringify({ action, ts, ...params });
  const signature = await hmacHex(body, secret);
  const doFetch = opts.fetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-shop-signature": signature,
      },
      body,
      signal: controller.signal,
    });
  } catch (error: any) {
    const why = error?.name === "AbortError" ? "keine Antwort nach 15 s" : String(error?.message ?? error);
    throw new ShopApiError(`Shop nicht erreichbar (${why}).`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const shopMessage =
    json && typeof json === "object"
      ? String(json.message ?? json.error ?? "").slice(0, 200)
      : "";

  if (response.status === 401 || response.status === 403) {
    throw new ShopApiError(
      "Der Shop lehnt die Anfrage ab (Signatur oder Zeitstempel). Ist SHOP_WEBHOOK_SECRET auf beiden Seiten gleich?",
    );
  }
  if (response.status === 404 && !json) {
    throw new ShopApiError(
      "Shop-Schnittstelle nicht gefunden (HTTP 404). Ist das Modul lusdigital im Shop installiert und aktiv?",
    );
  }
  if (!json || typeof json !== "object") {
    throw new ShopApiError(
      `Der Shop antwortet nicht wie erwartet (HTTP ${response.status}, kein JSON). Ist das Modul lusdigital installiert?`,
    );
  }
  if (!response.ok || json.ok !== true) {
    throw new ShopApiError(
      `Der Shop meldet einen Fehler${shopMessage ? `: ${shopMessage}` : ` (HTTP ${response.status})`}.`,
    );
  }
  return json;
}

/** Preis aus der Schnittstelle in Cent: 9.9, "9.90" oder "9,90". */
export function priceToCents(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim().replace(",", "."))
        : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100_000) return null;
  return Math.round(n * 100);
}

function asInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function httpUrl(value: unknown): string | null {
  const text = asText(value);
  return /^https?:\/\//i.test(text) ? text : null;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Ein Produkt aus der Antwort pruefen und in die eigene Form bringen. */
export function parseProduct(raw: any): ShopProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const id = asInt(raw.id);
  if (!id) return null;
  let digital: ShopDigital | null = null;
  if (raw.digital && typeof raw.digital === "object") {
    const attr = asInt(raw.digital.id_product_attribute);
    if (attr) {
      digital = {
        idProductAttribute: attr,
        sku: asText(raw.digital.sku),
        priceCents: priceToCents(raw.digital.price_gross),
        available: asBool(raw.digital.available),
      };
    }
  }
  return {
    id,
    name: asText(raw.name) || `Produkt ${id}`,
    reference: asText(raw.reference),
    priceCents: priceToCents(raw.price_gross),
    url: httpUrl(raw.url) ?? `${SHOP_URL}/index.php?controller=product&id_product=${id}`,
    coverUrl: httpUrl(raw.cover_url),
    manufacturer: asText(raw.manufacturer),
    active: asBool(raw.active),
    digital,
  };
}

export function parseProducts(json: Record<string, any>): ShopProduct[] {
  const list = Array.isArray(json.products) ? json.products : [];
  return list.map(parseProduct).filter((p): p is ShopProduct => p !== null);
}

/**
 * Suchbegriff fuer den Vorschlag: bei bekannten Reihen dieselbe Bezeichnung,
 * die der Shop fuehrt ("DMZ Nr. 170", "ZUERST! Maerz 2026"), sonst Reihenname
 * und Heftnummer.
 */
export function suggestQuery(
  publication: { name: string; slug: string },
  issue: { title: string; issueNumber?: string },
): string {
  const series = seriesFor(publication.slug);
  if (series && issue.issueNumber) {
    const q = searchQueryForIssue(series, issue.issueNumber);
    if (q) return q;
  }
  return [publication.name, issue.issueNumber ?? issue.title].filter(Boolean).join(" ");
}

/**
 * Treffer ordnen, bester zuerst: passende Heftnummer in Name oder Referenz,
 * Reihenname, aktiv. Bei gleichem Rang bleibt die Reihenfolge des Shops.
 */
export function rankProducts(
  products: ShopProduct[],
  publication: { name: string; slug: string },
  issueNumber: string | undefined,
): ShopProduct[] {
  const series = seriesFor(publication.slug);
  const pubName = publication.name.toLowerCase();
  const number = issueNumber?.trim();
  const numberToken = number ? /^(\d+)/.exec(number)?.[1] : undefined;
  const score = (p: ShopProduct) => {
    const hay = `${p.name} ${p.reference}`;
    let s = 0;
    if (series && number && designationMatches(series, hay, number)) s += 4;
    else if (numberToken && new RegExp(`(^|\\D)${numberToken}(\\D|$)`).test(hay)) s += 2;
    if (hay.toLowerCase().includes(pubName)) s += 1;
    if (p.active) s += 1;
    return s;
  };
  return products
    .map((p, i) => ({ p, i, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.p);
}

/** Kuerzel der Reihe fuer Artikelnummern: "ZUERST", "DMZ", "DMZ-ZG". */
export function seriesCode(publication: { name: string; slug: string }): string {
  const series = seriesFor(publication.slug);
  const base = series ? series.searchPrefix.split(/\s+/)[0] : publication.slug;
  const code = base
    .replace(/[äÄ]/g, "AE")
    .replace(/[öÖ]/g, "OE")
    .replace(/[üÜ]/g, "UE")
    .replace(/ß/g, "SS")
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return code || "HEFT";
}

/** Vorschlag fuer die Artikelnummer der Digital-Variante: `<KUERZEL>-<NR>-DIGITAL`. */
export function digitalSku(
  publication: { name: string; slug: string },
  issue: { issueNumber?: string; _id: string },
): string {
  const number = (issue.issueNumber ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const part = number || issue._id.slice(-6).toUpperCase();
  return `${seriesCode(publication)}-${part}-DIGITAL`;
}
