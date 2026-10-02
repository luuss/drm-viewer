/**
 * Buchanzeigen im Heft erkennen und dem Produkt im Laden zuordnen, ohne
 * Convex-Bezug: reine Funktionen, damit sich jede Regel an echten Anzeigen
 * testen laesst.
 *
 * Zwei Wege, in dieser Reihenfolge:
 *
 * 1. **Artikelnummer.** Eigenanzeigen in DMZ und DMZ-Zeitgeschichte tragen
 *    "Art. 101208". Das ist die Produktreferenz im Laden; verlinkt wird nur
 *    bei genau einem Produkt mit genau dieser Referenz.
 * 2. **Titel.** Anzeigen ohne Nummer (ZUERST!) und Buchbesprechungen nennen
 *    Titel, Verfasser, Umfang und Preis. Die Ladensuche ist unscharf ("Warum
 *    Krieg" trifft "Warum mussten Deutschlands Staedte sterben?"), deshalb
 *    zaehlt ein Treffer nur, wenn sein Name woertlich in der Titelzone der
 *    Anzeige steht und Preis oder Verfasser ihn bestaetigen. Bei Gleichstand
 *    (zwoelf Baende gleichen Namens) wird nichts verlinkt: keine Verknuepfung
 *    ist besser als eine falsche.
 *
 * Fremdanzeigen haben weder unsere Artikelnummer noch ein Produkt im Laden und
 * bleiben deshalb von selbst ohne Knopf.
 */
import { SHOP_URL } from "./shopCovers";

export type RuleBlock = { order: number; text: string };

export type NumberHint = {
  kind: "number";
  blockOrder: number;
  reference: string;
};

export type TitleHint = {
  kind: "title";
  blockOrder: number;
  /** Text, in dem der Produktname woertlich stehen muss. */
  zone: string;
  /** Zeilen, die als Ganzes ein Titel sein koennen (Ueberschriften der Anzeige). */
  lines: string[];
  /** Suchanfragen an den Laden, die genaueste zuerst. */
  queries: string[];
  priceCents: number | null;
};

export type Hint = NumberHint | TitleHint;

/** Was die Zuordnung von einem Produkt wissen muss (Teil von `ShopProduct`). */
export type RuleProduct = {
  id: number;
  name: string;
  reference: string;
  priceCents: number | null;
  manufacturer: string;
};

/** Hoechstens so viele Suchanfragen je Anzeige ohne Artikelnummer. */
export const MAX_TITLE_QUERIES = 6;
/** Ab so vielen Punkten gilt ein Titeltreffer (siehe `scoreByTitle`). */
export const TITLE_MIN_POINTS = 3;

// "Art. 101208", "Art.-Nr. 101208", "Artikelnummer: 101208", "Best.-Nr. 101208".
// Fuenf oder sechs Ziffern: so lang sind die Referenzen im Laden, und so lang
// ist kein Gesetzesartikel. Ohne Punkt und ohne "Nr." zaehlt "Art" nicht:
// "Truppen aller Art 120000 Mann" ist keine Bestellzeile.
const REFERENCE =
  /(?<![A-Za-zÄÖÜäöüß])(?:Art\.|Art(?:ikel)?\.?[\s-]*(?:[Nn]r\.?|[Nn]ummer)|Best(?:ell)?\.?[\s-]*(?:[Nn]r\.?|[Nn]ummer))\s*:?\s*(\d{5,6})(?!\d)/g;

// Umfangsangabe einer Buchbeschreibung: "216 S.,", "2.760 Seiten,".
const EXTENT = /(?<![\d.,])(\d{2,3}|\d\.\d{3})\s?(?:S\.|Seiten)\s?,/;
// Was auf den Umfang folgt, wenn wirklich ein Buch beschrieben wird.
const BOOK_WORDS =
  /\b(?:geb|Pb|brosch|kart|Abb|Fotos|Karten|Hardcover|Paperback|Softcover|Großformat|farbig|Leinen)|€|EUR/;

// "€ 17,90", "EUR 29,90", "€ 18,–" und "17,90 €". In den DMZ-Schriften kommt
// das Euro-Zeichen als "t" aus dem Satz ("t 29,80").
const PRICE_BEFORE = /(?:€|EUR|(?<![A-Za-zÄÖÜäöüß])t)\s?(\d{1,3}(?:\.\d{3})*),(\d{2}|[–—-])/;
const PRICE_AFTER = /(\d{1,3}(?:\.\d{3})*),(\d{2}|[–—-])\s?(?:€|EUR)/;

/** Wie weit hinter der Beschreibung die Artikelnummer stehen darf (Bloecke). */
const REFERENCE_REACH = 6;
/** Laengste Zeile, die noch als Titel- oder Verfasserzeile gilt. */
const MAX_LINE = 140;
const MAX_LINES = 5;
/** Bis hierhin ist ein Absatz eine reine Literaturangabe ("Verfasser. Titel. 368 S., …"). */
const MAX_CITATION_LEAD = 220;

/** Kleinbuchstaben ohne Akzente und Satzzeichen, als Woerter. */
export function tokens(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

// Zwei 32-Bit-Streuwerte (cyrb53), ohne Web Crypto: laeuft gleich in Abfrage,
// Mutation und Aktion.
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Schluessel eines Absatzes fuer Korrekturen der Redaktion. Er haengt nur an
 * den Woertern: dieselbe Anzeige im naechsten Heft oder nach einem neuen
 * Import bekommt denselben Schluessel, auch wenn Trennstriche anders fallen.
 */
export function blockKey(text: string): string {
  const normal = tokens(text).join(" ");
  return `${cyrb53(normal, 1).toString(36)}${cyrb53(normal, 2).toString(36)}`;
}

/**
 * Suchtext fuer den Laden. Dessen Suche verlangt jedes Wort; Anfuehrungen,
 * Gedankenstriche und Satzzeichen zaehlten sonst als Teil des Wortes
 * ("Böhmen–Mähren" findet nichts, "Böhmen Mähren" schon).
 */
export function searchQuery(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
}

function priceIn(text: string): number | null {
  const m = PRICE_BEFORE.exec(text) ?? PRICE_AFTER.exec(text);
  if (!m) return null;
  const euros = Number(m[1].replace(/\./g, ""));
  const cents = /^\d\d$/.test(m[2]) ? Number(m[2]) : 0;
  return Number.isFinite(euros) ? euros * 100 + cents : null;
}

/** Stelle der Umfangsangabe, wenn der Absatz ein Buch beschreibt. */
function extentAt(text: string): number | null {
  const m = EXTENT.exec(text);
  if (!m) return null;
  const danach = text.slice(m.index + m[0].length, m.index + m[0].length + 90);
  return BOOK_WORDS.test(danach) || priceIn(danach) !== null ? m.index : null;
}

function referencesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REFERENCE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function worthSearching(query: string): boolean {
  const words = tokens(query);
  // "E.G." unter einer Besprechung ist ein Kuerzel, kein Titel.
  if (words.join("").length < 6) return false;
  return words.length >= 2 || words[0].length >= 8;
}

function uniqueQueries(candidates: string[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const q = searchQuery(c);
    if (!worthSearching(q) || out.includes(q)) continue;
    out.push(q);
    if (out.length >= MAX_TITLE_QUERIES) break;
  }
  return out;
}

/** "Verfasser. Titel – Untertitel: Zusatz." in seine Teile zerlegen. */
function citationParts(lead: string): string[] {
  return lead
    .split(/(?<=[.!?:])\s+|\s+[–—]\s+/)
    .map((s) => s.replace(/[.:]+$/, "").trim())
    .filter(Boolean);
}

/**
 * Alle Hinweise auf Produkte in einem Artikel, in Lesereihenfolge.
 *
 * Eine Beschreibung mit Umfangsangabe, hinter der eine Artikelnummer folgt,
 * ist schon ueber die Nummer erfasst und bekommt keinen Titelhinweis.
 */
export function findHints(article: { title: string; blocks: RuleBlock[] }): Hint[] {
  const blocks = [...article.blocks].sort((a, b) => a.order - b.order);
  const refs = blocks.map((b) => referencesIn(b.text));
  const extents = blocks.map((b) => extentAt(b.text));
  const hints: Hint[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    for (const reference of refs[i]) {
      // Dieselbe Nummer zweimal im Artikel (Text und Bestellzeile) ist ein Produkt.
      if (seen.has(reference)) continue;
      seen.add(reference);
      hints.push({ kind: "number", blockOrder: blocks[i].order, reference });
    }

    const at = extents[i];
    if (at === null) continue;
    let covered = false;
    for (let j = i; j < Math.min(blocks.length, i + 1 + REFERENCE_REACH); j++) {
      if (j > i && extents[j] !== null) break;
      if (refs[j].length > 0) {
        covered = true;
        break;
      }
    }
    if (covered) continue;

    const text = blocks[i].text;
    const lead = text.slice(0, at).trim();
    const priceCents =
      priceIn(text.slice(at)) ??
      (blocks[i + 1] && blocks[i + 1].text.length <= MAX_LINE ? priceIn(blocks[i + 1].text) : null);

    // Zwei Formen. Literaturangabe am Ende einer Besprechung: "Verfasser.
    // Titel. 368 S., …", der Titel steht im Absatz selbst. Anzeige: kurze
    // Zeilen mit Verfasser und Titel, darunter die Beschreibung, an deren
    // Ende der Umfang steht. Ein kurzer Absatz kann beides sein; dann zaehlen
    // die Zeilen darueber und der Absatz selbst.
    const citation = lead.length >= 8 && lead.length <= MAX_CITATION_LEAD ? lead : "";
    let above = i - 1;
    let description = citation ? "" : text;
    if (
      lead.length < 8 &&
      above >= 0 &&
      blocks[above].text.length > MAX_LINE &&
      extents[above] === null &&
      refs[above].length === 0
    ) {
      // Die Umfangsangabe steht in einem eigenen Absatz unter der Beschreibung.
      description = blocks[above].text;
      above -= 1;
    }
    const lines: string[] = [];
    let j = above;
    for (; j >= 0 && lines.length < MAX_LINES; j--) {
      const line = blocks[j].text.trim();
      if (!line || line.length > MAX_LINE || extents[j] !== null || refs[j].length > 0) break;
      lines.unshift(line);
    }
    // Reichen die Zeilen bis an den Anfang des Artikels, fehlt der Buchtitel:
    // der Lesetext wiederholt den Artikeltitel nicht. Im Satz stand er
    // zwischen Verfasser und Beschreibung ("Sophie Liebnitz" /
    // "Halbmondsüchtig" / "Xenomanie in Europa. – …"), dort gehoert er hin.
    const title = article.title.trim();
    if (
      ((j < 0 && lines.length > 0) || (!citation && lines.length === 0)) &&
      title &&
      title.length <= MAX_LINE &&
      !title.endsWith("…") &&
      lines.length < MAX_LINES &&
      !lines.some((l) => tokens(l).join(" ") === tokens(title).join(" "))
    ) {
      lines.push(title);
    }
    // Der Untertitel laeuft oft in die Beschreibung: "Aufarbeiten statt
    // verdrängen. – Die Vertreibung …".
    const opening = /^(.{4,160}?)\s+[–—]\s/.exec(description)?.[1] ?? "";
    const parts = citation ? citationParts(citation) : [];
    // Haupttitel bis zum Doppelpunkt, samt Gedankenstrich ("Unbekannt – April
    // 1945: Chronik …"); in Teile zerlegt waere er zerrissen.
    const mainTitle = /^[^.!?]*[.!?]\s+([^:]+)/.exec(citation)?.[1] ?? "";
    // Ohne Titel im Text (er steht nur auf dem abgebildeten Umschlag) bleibt
    // der Hinweis ohne Anfrage: die Redaktion sieht die Anzeige als nicht
    // zugeordnet und kann das Produkt von Hand waehlen.
    hints.push({
      kind: "title",
      blockOrder: blocks[i].order,
      zone: [...lines, citation || opening].join(" ").trim(),
      lines: [...lines, ...parts],
      // Alle Zeilen zusammen sind die genaueste Anfrage (der Verfasser steht
      // im Laden als Hersteller), danach die Zeilen einzeln, die unterste
      // zuerst. Der Name des Verfassers allein faende alle seine Buecher und
      // kommt deshalb zuletzt.
      queries: uniqueQueries([
        lines.join(" "),
        ...[...lines].reverse(),
        mainTitle,
        ...parts.slice(1),
        parts[0] ?? "",
      ]),
      priceCents,
    });
  }
  return hints;
}

/** Genau ein Produkt mit genau dieser Referenz, sonst keins. */
export function pickByReference<P extends RuleProduct>(
  products: P[],
  reference: string,
): P | null {
  const hits = products.filter((p) => p.reference.trim() === reference);
  return hits.length === 1 ? hits[0] : null;
}

function indexOfRun(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Nachnamen aus dem Herstellerfeld: "Alfred de Zayas/Konrad Badenheuer". */
function surnames(manufacturer: string): string[] {
  return manufacturer
    .replace(/\([^)]*\)/g, " ")
    .split(/[/,;&]|\s+und\s+/)
    .map((name) => tokens(name).pop() ?? "")
    .filter((name) => name.length >= 3);
}

const VOLUME_WORDS = new Set(["band", "bd", "teil"]);
const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6",
  vii: "7", viii: "8", ix: "9", x: "10", xi: "11", xii: "12",
};
const volumeNumber = (token: string) => ROMAN[token] ?? token;

/**
 * Der Produktname, wie er in der Titelzone steht. Der Laden haengt den Band
 * an den Namen ("Unbekannt - April 1945, Band 1"), im Heft steht er hinter
 * dem Untertitel ("… Soldatenfriedhofs Halbe. Bd. 1: …"). Dann genuegt der
 * Name ohne Band, wenn die Zone denselben Band nennt.
 */
function nameInZone(name: string[], zone: string[]): string[] | null {
  if (name.length === 0) return null;
  if (indexOfRun(zone, name) >= 0) return name;
  const n = name.length;
  if (n < 3 || !VOLUME_WORDS.has(name[n - 2])) return null;
  const base = name.slice(0, n - 2);
  const volume = volumeNumber(name[n - 1]);
  const named = zone.some(
    (t, i) => VOLUME_WORDS.has(t) && i + 1 < zone.length && volumeNumber(zone[i + 1]) === volume,
  );
  return named && indexOfRun(zone, base) >= 0 ? base : null;
}

/**
 * Wie sicher ein Suchtreffer die Anzeige meint. `null`, wenn der Name nicht
 * woertlich in der Titelzone steht; sonst Punkte:
 *
 *   +2  Preis der Anzeige = Preis im Laden
 *   +2  alle Verfasser des Ladens stehen in der Titelzone
 *   +1  der Name ist genau eine Zeile (oder zwei aufeinanderfolgende)
 *   +1  der Name hat mindestens drei Woerter
 *   -1  der Name ist ein einzelnes Wort
 *   -1  beide Preise bekannt, aber verschieden
 */
export function scoreByTitle(product: RuleProduct, hint: TitleHint): number | null {
  const zone = tokens(hint.zone);
  const name = nameInZone(tokens(product.name), zone);
  if (name === null) return null;

  let points = 0;
  if (hint.priceCents !== null && product.priceCents !== null) {
    points += hint.priceCents === product.priceCents ? 2 : -1;
  }
  const authors = surnames(product.manufacturer);
  if (authors.length > 0 && authors.every((a) => zone.includes(a))) points += 2;

  const key = name.join(" ");
  const lineKeys = hint.lines.map((l) => tokens(l).join(" "));
  const exact =
    lineKeys.includes(key) ||
    lineKeys.some((l, i) => i + 1 < lineKeys.length && `${l} ${lineKeys[i + 1]}` === key);
  if (exact) points += 1;
  if (name.length >= 3) points += 1;
  if (name.length === 1) points -= 1;
  return points;
}

/**
 * Das eine Produkt, das die Anzeige meint. Bei mehreren gleich guten Treffern
 * (Baende gleichen Namens und Preises) keins.
 */
export function pickByTitle<P extends RuleProduct>(products: P[], hint: TitleHint): P | null {
  const byId = new Map<number, { product: P; points: number }>();
  for (const product of products) {
    const points = scoreByTitle(product, hint);
    if (points === null || points < TITLE_MIN_POINTS) continue;
    byId.set(product.id, { product, points });
  }
  const ranked = [...byId.values()].sort((a, b) => b.points - a.points);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[1].points === ranked[0].points) return null;
  return ranked[0].product;
}

/** Nur Adressen des Ladens werden im Leser zu Knoepfen. */
export function isShopUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const shop = new URL(SHOP_URL);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === shop.hostname || parsed.hostname === `www.${shop.hostname}`)
    );
  } catch {
    return false;
  }
}
