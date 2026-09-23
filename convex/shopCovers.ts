/**
 * Titelbilder und Heftbezeichnungen der Zeitschriftenreihen aus dem
 * Verlagsshop lesenundschenken.de.
 *
 * Die Startseite des Shops fuehrt ganz unten eine Leiste mit der jeweils
 * aktuellen Ausgabe jeder Reihe: Verweis auf die Reihe und Titelbild in
 * kleiner Groesse. Aus der Bild-Nummer ergibt sich das grosse Bild — das
 * Original unter img/p/ (Ziffern der Nummer als Ordner), ersatzweise die
 * Groesse large_default.
 *
 * Jedes Heft ist im Shop ein Produkt mit Name ("Carpiquet 1944"),
 * Heftbezeichnung ("DMZ-ZG Nr. 82", bei ZUERST! der Monat) und
 * Unter-Ueberschrift ("Ausgabe Juli/August 2026"). Produktkarten stehen auf
 * Kategorie- und Suchseiten, die drei Angaben vollstaendig auf der
 * Produktseite. Die Suche findet ein Heft ueber seine Bezeichnung.
 *
 * Reine Funktionen ohne Convex-Bezug, damit sie sich testen lassen.
 */

export const SHOP_URL = "https://lesenundschenken.de";

export type Series = {
  /** Kennung des Titels hier. */
  slug: string;
  /** Kennung der Reihe im Shop (Ende des Kategorie-Links). */
  shopSlug: string;
  /** Pfad der Kategorie im Shop. */
  category: string;
  /** Anfang der Heftbezeichnung, wie ihn die Suche braucht. */
  searchPrefix: string;
  /** Hefte tragen eine Nummer ("Nr. 170", "Heft 36"); sonst den Monat. */
  numbered: boolean;
};

export const SERIES: Series[] = [
  { slug: "zuerst", shopSlug: "zuerst", category: "zeitschriften/zuerst", searchPrefix: "ZUERST!", numbered: false },
  { slug: "dmz", shopSlug: "dmz", category: "zeitschriften/dmz", searchPrefix: "DMZ Nr.", numbered: true },
  { slug: "dmz-zeitgeschichte", shopSlug: "dmz-zeitgeschichte", category: "zeitschriften/dmz-zeitgeschichte", searchPrefix: "DMZ-ZG Nr.", numbered: true },
  { slug: "schwertertraeger", shopSlug: "schwertertrager", category: "zeitschriften/schwertertraeger", searchPrefix: "Schwerterträger Heft", numbered: true },
];

export function seriesFor(slug: string): Series | null {
  return SERIES.find((s) => s.slug === slug) ?? null;
}

export type StripEntry = {
  shopSlug: string;
  /** Kennung des Titels hier, wenn die Reihe bekannt ist. */
  slug: string | null;
  imageId: string;
  imageName: string;
  /** Titel der aktuellen Ausgabe, wie ihn die Leiste nennt. */
  label: string;
};

export type ProductCard = {
  name: string;
  designation: string;
  imageId: string | null;
  url: string;
};

export type ProductPage = {
  name: string;
  designation: string | null;
  subtitle: string | null;
  pages: string | null;
  /** Einzelpreis in Cent, wie der Verlag ihn im Netzladen fuehrt. */
  priceCents: number | null;
};

const ITEM = /<a\b[^>]*href="https?:\/\/lesenundschenken\.de\/\d+-([a-z0-9-]+)\/?"[^>]*>\s*<img\b([^>]*)>/gi;
const SRC = /src="https?:\/\/lesenundschenken\.de\/(\d+)-[a-z_]+\/([^"]+)\.jpg"/i;
const ALT = /alt="([^"]*)"/i;
const CARD = /<article\b[^>]*class="[^"]*product-miniature[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
const CARD_TITLE = /class="[^"]*product-title[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
const CARD_AUTHOR = /class="lus-mini-author"[^>]*>([\s\S]*?)<\//i;
const CARD_IMAGE = /https?:\/\/lesenundschenken\.de\/(\d+)-(?:large|medium|home)_default\//i;
const PAGE_H1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const PAGE_TITLE = /<title>([\s\S]*?)<\/title>/i;

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Eintraege der Zeitschriften-Leiste auf der Startseite des Shops. */
export function parseMagazineStrip(html: string): StripEntry[] {
  const start = html.indexOf("lus-mag-list");
  const region = start >= 0 ? html.slice(start) : html;
  const out: StripEntry[] = [];
  for (const match of region.matchAll(ITEM)) {
    const shopSlug = match[1].toLowerCase();
    const src = SRC.exec(match[2]);
    if (!src) continue;
    const alt = decode(ALT.exec(match[2])?.[1] ?? "");
    // "DMZ – Der Schild Japans": Reihe, Gedankenstrich, Ausgabe.
    const label = alt.includes("–") ? alt.slice(alt.indexOf("–") + 1).trim() : alt;
    out.push({
      shopSlug,
      slug: SERIES.find((s) => s.shopSlug === shopSlug)?.slug ?? null,
      imageId: src[1],
      imageName: src[2],
      label,
    });
  }
  return out;
}

/** Adressen des grossen Bilds, beste zuerst. */
export function coverCandidates(entry: Pick<StripEntry, "imageId" | "imageName">): string[] {
  const folders = entry.imageId.split("").join("/");
  return [
    `${SHOP_URL}/img/p/${folders}/${entry.imageId}.jpg`,
    `${SHOP_URL}/${entry.imageId}-large_default/${entry.imageName}.jpg`,
  ];
}

/** Produktkarten einer Kategorie- oder Suchseite. */
export function parseProductCards(html: string): ProductCard[] {
  const out: ProductCard[] = [];
  for (const match of html.matchAll(CARD)) {
    const card = match[1];
    const title = CARD_TITLE.exec(card);
    if (!title) continue;
    const image = CARD_IMAGE.exec(card);
    out.push({
      name: decode(title[2]),
      designation: decode(CARD_AUTHOR.exec(card)?.[1] ?? ""),
      imageId: image?.[1] ?? null,
      url: title[1],
    });
  }
  return out;
}

function headField(html: string, klass: string): string | null {
  const match = new RegExp(`<(div|span|p)\\b[^>]*class="[^"]*\\b${klass}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`, "i").exec(html);
  const text = match ? decode(match[2]) : "";
  return text || null;
}

/**
 * Der Einzelpreis der Produktseite.
 *
 * Der Laden schreibt ihn maschinenlesbar aus: `itemprop="price" content="8.7"`.
 * Das ist die einzige verlaessliche Quelle fuer Reihen, die den Preis nur auf
 * die Titelseite drucken — im Innenteil steht bei ZUERST! ausschliesslich der
 * Abopreis, und die Titelseite ist ein Bild.
 */
export function parsePrice(html: string): number | null {
  const treffer = /itemprop="price"[^>]*content="([0-9]+(?:[.,][0-9]{1,2})?)"/i.exec(html);
  if (!treffer) return null;
  const euro = Number(treffer[1].replace(",", "."));
  if (!Number.isFinite(euro) || euro <= 0) return null;
  return Math.round(euro * 100);
}

/** Name, Heftbezeichnung und Unter-Ueberschrift von der Produktseite. */
export function parseProductPage(html: string): ProductPage | null {
  const start = html.indexOf("lus-product-head");
  const region = start >= 0 ? html.slice(start, start + 6000) : html;
  const name = decode(PAGE_H1.exec(region)?.[1] ?? PAGE_H1.exec(html)?.[1] ?? PAGE_TITLE.exec(html)?.[1] ?? "");
  if (!name) return null;
  return {
    name,
    designation: headField(region, "lus-head-author"),
    subtitle: headField(region, "lus-untertitel"),
    pages: headField(region, "lus-head-pages"),
    // Der Preis steht ausserhalb des Kopfbereichs, deshalb im ganzen Dokument.
    priceCents: parsePrice(html),
  };
}

export const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** Suchbegriff, mit dem der Shop ein Heft nach seiner Bezeichnung findet. */
export function searchQueryForIssue(series: Series, issueNumber: string): string | null {
  const number = issueNumber.trim();
  if (series.numbered) {
    const match = /^(\d+)/.exec(number);
    return match ? `${series.searchPrefix} ${match[1]}` : null;
  }
  // "3/2026" oder "7-8/2026": Monat(e) und Jahr.
  const match = /^(\d{1,2})(?:[-/](\d{1,2}))?\/(\d{4})$/.exec(number);
  if (!match) return null;
  const month = MONTHS[Number(match[1]) - 1];
  return month ? `${series.searchPrefix} ${month} ${match[3]}` : null;
}

/** Ob eine Heftbezeichnung aus dem Shop zu unserer Heftnummer gehoert. */
export function designationMatches(series: Series, designation: string, issueNumber: string): boolean {
  const number = issueNumber.trim();
  if (series.numbered) {
    const wanted = /^(\d+)/.exec(number)?.[1];
    const found = /(?:Nr\.?|Heft)\s*(\d+)\b/i.exec(designation)?.[1];
    return !!wanted && found === wanted;
  }
  const match = /^(\d{1,2})(?:[-/](\d{1,2}))?\/(\d{4})$/.exec(number);
  if (!match) return false;
  const months = [match[1], match[2]].filter(Boolean).map((m) => MONTHS[Number(m) - 1]);
  return designation.includes(match[3]) && months.some((m) => m && designation.includes(m));
}

/** Kategorie-Seite, neueste Hefte zuerst (Artikelnummern steigen je Ausgabe). */
export function categoryUrl(series: Series, page = 1): string {
  return `${SHOP_URL}/${series.category}/?order=product.reference.desc${page > 1 ? `&page=${page}` : ""}`;
}

export function searchUrl(query: string): string {
  return `${SHOP_URL}/suche?controller=search&s=${encodeURIComponent(query)}`;
}
