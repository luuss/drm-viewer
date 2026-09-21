/**
 * Titelbilder der Zeitschriftenreihen aus dem Verlagsshop lesenundschenken.de.
 *
 * Die Startseite des Shops fuehrt ganz unten eine Leiste mit der jeweils
 * aktuellen Ausgabe jeder Reihe. Jeder Eintrag verweist auf die Reihe und
 * zeigt das Titelbild in kleiner Groesse; aus der Bild-Nummer ergibt sich das
 * grosse Bild: das Original unter img/p/ (Ziffern der Nummer als Ordner),
 * ersatzweise die Groesse large_default (800 px hoch).
 *
 * Reine Funktionen ohne Convex-Bezug, damit sie sich testen lassen.
 */

export const SHOP_URL = "https://lesenundschenken.de";

/** Kennung der Reihe im Shop (Ende des Kategorie-Links) → Kennung hier. */
export const SHOP_SERIES: Record<string, string> = {
  zuerst: "zuerst",
  dmz: "dmz",
  "dmz-zeitgeschichte": "dmz-zeitgeschichte",
  schwertertrager: "schwertertraeger",
};

export type StripEntry = {
  /** Kennung der Reihe im Shop. */
  shopSlug: string;
  /** Kennung des Titels hier, wenn die Reihe bekannt ist. */
  slug: string | null;
  imageId: string;
  imageName: string;
  /** Titel der aktuellen Ausgabe, wie ihn der Shop nennt. */
  label: string;
};

const ITEM = /<a\b[^>]*href="https?:\/\/lesenundschenken\.de\/\d+-([a-z0-9-]+)\/?"[^>]*>\s*<img\b([^>]*)>/gi;
const SRC = /src="https?:\/\/lesenundschenken\.de\/(\d+)-[a-z_]+\/([^"]+)\.jpg"/i;
const ALT = /alt="([^"]*)"/i;

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&ndash;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Eintraege der Zeitschriften-Leiste auf der Startseite des Shops. */
export function parseMagazineStrip(html: string): StripEntry[] {
  const start = html.indexOf("lus-mag-list");
  const region = start >= 0 ? html.slice(start) : html;
  const out: StripEntry[] = [];
  for (const match of region.matchAll(ITEM)) {
    const shopSlug = match[1].toLowerCase();
    const img = match[2];
    const src = SRC.exec(img);
    if (!src) continue;
    const alt = decode(ALT.exec(img)?.[1] ?? "");
    // "DMZ – Der Schild Japans": Reihe, Gedankenstrich, Ausgabe.
    const label = alt.includes("–") ? alt.slice(alt.indexOf("–") + 1).trim() : alt;
    out.push({
      shopSlug,
      slug: SHOP_SERIES[shopSlug] ?? null,
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
