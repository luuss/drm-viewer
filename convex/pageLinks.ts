/**
 * Klickflaechen auf einer Seite, die nicht zu einem Artikel fuehren, sondern
 * nach draussen — in den Laden.
 *
 * Eine Anzeigenseite ist kein Lesetext. Ein Tipp darauf oeffnet im neuen Tab
 * und ohne Zwischenfrage:
 *
 * * `subscription` — das Abo-Formular der beworbenen Reihe
 *   (`publications.shopPrintSubscriptionUrl`, sonst das bekannte Formular);
 * * `series` — die Kategorie einer Reihe (Sammelanzeige fuer deren Hefte);
 * * `shop` — ein Produkt oder eine Suche: `reference` oder `queries` nennen,
 *   wonach zu suchen ist, `resolveInternal` fragt den Laden und traegt `url`
 *   ein (Produktseite bei genau einem Treffer, sonst die Suchseite);
 * * `url` — eine feste Adresse.
 *
 * Der Import legt diese Flaechen an (`source: "import"`, bei jedem Lauf
 * ersetzt); die Redaktion kann eigene dazulegen, die bleiben.
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireEditor, audit } from "./roles";
import { internal } from "./_generated/api";
import { hasIssueAccess } from "./access";
import { Doc, Id } from "./_generated/dataModel";
import { SHOP_URL, seriesFor } from "./shopCovers";
import { callShopApi, parseProducts, ShopApiError, type ShopProduct } from "./shopApi";
import { isShopUrl } from "./articleProductRules";

export const linkKind = v.union(
  v.literal("subscription"),
  v.literal("series"),
  v.literal("shop"),
  v.literal("url"),
);

export const pageLinkInput = v.object({
  pageIndex: v.number(),
  x0: v.number(),
  y0: v.number(),
  x1: v.number(),
  y1: v.number(),
  kind: linkKind,
  publicationSlug: v.optional(v.string()),
  url: v.optional(v.string()),
  queries: v.optional(v.array(v.string())),
  reference: v.optional(v.string()),
  single: v.optional(v.boolean()),
  label: v.optional(v.string()),
});

type PageLinkInput = {
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: "subscription" | "series" | "shop" | "url";
  publicationSlug?: string;
  url?: string;
  queries?: string[];
  reference?: string;
  single?: boolean;
  label?: string;
};

/** Das Abo-Formular einer Reihe im Laden, solange die Redaktion keins eintraegt. */
export function defaultSubscriptionUrl(slug: string): string {
  return `${SHOP_URL}/module/luszeitformulare/formular?f=abo-${slug}`;
}

/** Die Kategorie einer Reihe im Laden. */
export function seriesUrl(slug: string): string {
  const series = seriesFor(slug);
  return `${SHOP_URL}/${series?.category ?? `zeitschriften/${slug}`}`;
}

/** Die Suchseite des Ladens. */
export function searchUrl(query: string): string {
  return `${SHOP_URL}/suche?s=${encodeURIComponent(query)}`;
}

/**
 * Das Produkt zu einer Anzeige: bei Artikelnummer das mit genau dieser
 * Referenz, sonst der einzige Treffer. Mehrere Treffer sind keiner — dann
 * zeigt die Suchseite alle.
 */
export function chooseProduct(
  products: ShopProduct[],
  reference?: string,
): ShopProduct | null {
  const brauchbar = products.filter((p) => p.active && isShopUrl(p.url));
  if (reference) {
    const genau = brauchbar.filter((p) => p.reference === reference);
    return genau.length === 1 ? genau[0] : null;
  }
  return brauchbar.length === 1 ? brauchbar[0] : null;
}

/** Die Flaechen des Imports ersetzen; von der Redaktion angelegte bleiben. */
export async function replaceImportedLinks(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  links: PageLinkInput[],
): Promise<number> {
  const old = await ctx.db
    .query("pageLinks")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  for (const row of old) {
    if (row.source === "import") await ctx.db.delete(row._id);
  }
  for (const link of links) {
    await ctx.db.insert("pageLinks", { issueId, ...link, source: "import" });
  }
  return links.length;
}

/** Wohin eine Flaeche fuehrt — null, wenn es (noch) kein Ziel gibt. */
async function zielAdresse(
  ctx: { db: any },
  row: Doc<"pageLinks">,
  adressen: Map<string, string>,
): Promise<string | null> {
  if (row.url) return row.url;
  if (row.kind === "subscription" && row.publicationSlug) {
    const slug = row.publicationSlug;
    if (!adressen.has(slug)) {
      const publication = await ctx.db
        .query("publications")
        .withIndex("by_slug", (q: any) => q.eq("slug", slug))
        .unique();
      adressen.set(slug, publication?.shopPrintSubscriptionUrl || defaultSubscriptionUrl(slug));
    }
    return adressen.get(slug) ?? null;
  }
  if (row.kind === "series" && row.publicationSlug) return seriesUrl(row.publicationSlug);
  if (row.kind === "shop") {
    // Eine Buchflaeche, zu der der Laden nichts fuehrt, fuehrt nirgendwohin:
    // der Tipp oeffnet dann die Anzeige (mit "Zum Shop"), keine leere Suche.
    if (row.resolvedAt && row.label?.includes(BOOK_LABEL_SEPARATOR)) return null;
    // Noch nicht aufgeloest: die Suchseite mit dem genauesten Begriff.
    const q = row.queries?.[0] ?? row.reference;
    return q ? searchUrl(q) : SHOP_URL;
  }
  return null;
}

export const forReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const rows = await ctx.db
      .query("pageLinks")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const adressen = new Map<string, string>();
    const out: {
      pageIndex: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      url: string;
      label: string | null;
    }[] = [];
    for (const row of rows) {
      const url = await zielAdresse(ctx, row, adressen);
      if (!url) continue;
      out.push({
        pageIndex: row.pageIndex,
        x0: row.x0,
        y0: row.y0,
        x1: row.x1,
        y1: row.y1,
        url,
        label: row.label ?? null,
      });
    }
    return out;
  },
});

/**
 * Alle Flaechen eines Hefts fuer die Redaktion, mit dem Ziel, das der Leser
 * bekaeme. Sie sieht auch, was der Import angelegt hat.
 */
export const listForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("pageLinks")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .take(2000);
    const adressen = new Map<string, string>();
    return Promise.all(
      rows.map(async (row) => ({
        _id: row._id,
        pageIndex: row.pageIndex,
        x0: row.x0,
        y0: row.y0,
        x1: row.x1,
        y1: row.y1,
        kind: row.kind,
        publicationSlug: row.publicationSlug ?? null,
        url: row.url ?? null,
        reference: row.reference ?? null,
        queries: row.queries ?? [],
        label: row.label ?? null,
        source: row.source,
        target: await zielAdresse(ctx, row, adressen),
      })),
    );
  },
});

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Eine Flaeche anlegen oder aendern. Was die Redaktion anfasst, gehoert ihr
 * (`source: "editor"`) und uebersteht damit einen neuen Import.
 */
export const save = mutation({
  args: {
    issueId: v.id("issues"),
    linkId: v.optional(v.id("pageLinks")),
    link: pageLinkInput,
  },
  handler: async (ctx, { issueId, linkId, link }) => {
    await requireEditor(ctx);
    const box = {
      x0: clamp01(Math.min(link.x0, link.x1)),
      x1: clamp01(Math.max(link.x0, link.x1)),
      y0: clamp01(Math.min(link.y0, link.y1)),
      y1: clamp01(Math.max(link.y0, link.y1)),
    };
    if (box.x1 - box.x0 < 0.005 || box.y1 - box.y0 < 0.005) {
      throw new Error("Die Fläche ist zu klein");
    }
    if (link.kind === "url" && !/^https?:\/\//.test(link.url ?? "")) {
      throw new Error("Bitte eine vollständige Adresse mit https:// angeben");
    }
    if ((link.kind === "subscription" || link.kind === "series") && !link.publicationSlug) {
      throw new Error("Bitte eine Reihe wählen");
    }
    if (link.kind === "shop" && !link.reference && !(link.queries ?? []).some((q) => q.trim())) {
      throw new Error("Bitte einen Suchbegriff oder eine Artikelnummer angeben");
    }
    const roh: Record<string, unknown> = {
      ...link,
      ...box,
      // Fuer `shop` gilt die Aufloesung neu; eine feste Adresse bleibt.
      url: link.kind === "url" ? link.url : undefined,
      queries: link.kind === "shop" ? (link.queries ?? []).filter((q) => q.trim()) : undefined,
      reference: link.kind === "shop" ? link.reference || undefined : undefined,
      publicationSlug:
        link.kind === "subscription" || link.kind === "series" ? link.publicationSlug : undefined,
      source: "editor",
    };
    for (const k of Object.keys(roh)) if (roh[k] === undefined) delete roh[k];
    const row = roh as Omit<Doc<"pageLinks">, "_id" | "_creationTime" | "issueId">;
    let id: Id<"pageLinks">;
    if (linkId) {
      const old = await ctx.db.get(linkId);
      if (!old || old.issueId !== issueId) throw new Error("Fläche nicht gefunden");
      await ctx.db.replace(linkId, { issueId, ...row });
      id = linkId;
    } else {
      id = await ctx.db.insert("pageLinks", { issueId, ...row });
    }
    if (link.kind === "shop") {
      await ctx.scheduler.runAfter(0, internal.pageLinks.resolveInternal, { issueId });
    }
    await audit(ctx, "pageLink.save", issueId, link.kind);
    return id;
  },
});

export const remove = mutation({
  args: { linkId: v.id("pageLinks") },
  handler: async (ctx, { linkId }) => {
    await requireEditor(ctx);
    const row = await ctx.db.get(linkId);
    if (!row) return;
    await ctx.db.delete(linkId);
    await audit(ctx, "pageLink.remove", row.issueId, row.kind);
  },
});

export const replaceImportedInternal = internalMutation({
  args: { issueId: v.id("issues"), links: v.array(pageLinkInput) },
  handler: async (ctx, { issueId, links }) => ({
    links: await replaceImportedLinks(ctx, issueId, links),
  }),
});

/**
 * Nur die Buchflaechen eines Hefts ersetzen (Label mit " · "), alle anderen
 * Flaechen bleiben — fuer das Nachruesten schon importierter Hefte
 * (extract-service/tools/buecher_nachruesten.py). Danach `resolveInternal`.
 */
export const replaceBooksInternal = internalMutation({
  args: { issueId: v.id("issues"), links: v.array(pageLinkInput) },
  handler: async (ctx, { issueId, links }) => {
    const old = await ctx.db
      .query("pageLinks")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    let removed = 0;
    for (const row of old) {
      if (row.source === "import" && row.label?.includes(BOOK_LABEL_SEPARATOR)) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    for (const link of links) {
      if (!link.label?.includes(BOOK_LABEL_SEPARATOR)) continue;
      await ctx.db.insert("pageLinks", { issueId, ...link, source: "import" });
    }
    await ctx.scheduler.runAfter(0, internal.pageLinks.resolveInternal, { issueId });
    return { removed, added: links.length };
  },
});

/** Eine Flaeche ohne Anmeldung anlegen — fuer Werkzeuge mit Deploy-Schluessel. */
export const addInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    link: pageLinkInput,
    source: v.optional(v.union(v.literal("import"), v.literal("editor"))),
  },
  handler: async (ctx, { issueId, link, source }) =>
    await ctx.db.insert("pageLinks", { issueId, ...link, source: source ?? "import" }),
});

export const listUnresolvedInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const rows = await ctx.db
      .query("pageLinks")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    // Eine Buchflaeche, die auf die Suchseite fuehrt, ist nicht fertig: der
    // Laden kann das Buch inzwischen eindeutig fuehren.
    const offen = rows.filter(
      (r) =>
        r.kind === "shop" &&
        (!r.url ||
          (r.source === "import" &&
            r.label?.includes(BOOK_LABEL_SEPARATOR) &&
            r.url.includes("/suche?"))),
    );
    const fallback = await adProductsForLinks(ctx, issueId, offen);
    return offen.map((r) => ({
      id: r._id,
      queries: r.queries ?? [],
      reference: r.reference ?? null,
      single: r.single ?? false,
      label: r.label ?? null,
      fallback: fallback.get(r._id) ?? [],
    }));
  },
});

/** Ab diesem Anteil seiner Flaeche liegt eine Artikelflaeche unter einer Buchflaeche. */
const UNDER_LINK_SHARE = 0.5;

type Box = { x0: number; y0: number; x1: number; y1: number };
const boxArea = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Liegt die Textflaeche eines Artikels unter der Buchflaeche? */
export function textUnderLink(region: Box, link: Box): boolean {
  const a = boxArea(region);
  return a > 0 && overlapArea(region, link) >= UNDER_LINK_SHARE * a;
}

/**
 * Die Produkte, die der Abgleich der Anzeigen (articleProducts) den Artikeln
 * unter jeder Buchflaeche gegeben hat — als Rueckfall fuer `resolveInternal`.
 */
async function adProductsForLinks(
  ctx: { db: any },
  issueId: Id<"issues">,
  links: Doc<"pageLinks">[],
): Promise<Map<Id<"pageLinks">, ShopProduct[]>> {
  const out = new Map<Id<"pageLinks">, ShopProduct[]>();
  const buecher = links.filter((l) => l.label?.includes(BOOK_LABEL_SEPARATOR));
  if (!buecher.length) return out;
  const rows: Doc<"articleProducts">[] = await ctx.db
    .query("articleProducts")
    .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
    .collect();
  const jeArtikel = new Map<string, number[]>();
  for (const row of rows) {
    if (row.productId === undefined) continue;
    const block = await ctx.db.get(row.blockId);
    if (!block) continue;
    const ids = jeArtikel.get(block.articleId) ?? [];
    if (!ids.includes(row.productId)) ids.push(row.productId);
    jeArtikel.set(block.articleId, ids);
  }
  if (!jeArtikel.size) return out;
  const regions: Doc<"articleRegions">[] = await ctx.db
    .query("articleRegions")
    .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
    .collect();
  const produkte = new Map<number, ShopProduct | null>();
  for (const link of buecher) {
    const ids = new Set<number>();
    for (const r of regions) {
      // Text oder Umschlag des Artikels unter der Flaeche (bei Besprechungen
      // ist die Flaeche das Umschlagbild, der Text steht daneben).
      if (r.pageIndex !== link.pageIndex || r.targetPageIndex !== undefined) continue;
      if (!textUnderLink(r, link)) continue;
      for (const id of jeArtikel.get(r.articleId) ?? []) ids.add(id);
    }
    const liste: ShopProduct[] = [];
    for (const id of ids) {
      if (!produkte.has(id)) {
        const p: Doc<"shopProducts"> | null = await ctx.db
          .query("shopProducts")
          .withIndex("by_product", (q: any) => q.eq("productId", id))
          .first();
        produkte.set(
          id,
          p
            ? {
                id: p.productId,
                name: p.name,
                reference: p.reference,
                priceCents: p.priceCents ?? null,
                url: p.url,
                coverUrl: null,
                manufacturer: "",
                active: p.active,
                digital: null,
              }
            : null,
        );
      }
      const p = produkte.get(id);
      if (p) liste.push(p);
    }
    if (liste.length) out.set(link._id, liste);
  }
  return out;
}

/**
 * Rueckfall aus der Anzeige unter der Buchflaeche. Ihr Abgleich verlangt den
 * Namen woertlich in der Anzeige und prueft den Preis; uebernommen wird ein
 * Produkt, dessen Name zum Titel der Flaeche passt oder ganz in ihm steht
 * ("Propaganda" in "Propaganda oder der Mythos der Demokratie").
 */
export function chooseFromAd(
  products: ShopProduct[],
  label: string,
  reference?: string | null,
): ShopProduct | null {
  const brauchbar = [...new Map(products.map((p) => [p.url, p])).values()].filter(
    (p) => p.active && isShopUrl(p.url),
  );
  if (reference) {
    const genau = brauchbar.filter((p) => p.reference === reference);
    if (genau.length === 1) return genau[0];
  }
  // Auch hier muss der Name zum Titel passen: die Bilder eines Bucherseiten-
  // Artikels liegen nicht immer unter dem eigenen Buch.
  const { title } = splitBookLabel(label);
  const titel = new Set(titleWords(title));
  const passend = brauchbar.filter((p) => {
    if (titleRank(p.name, title) > 0) return true;
    const name = titleWords(p.name);
    return name.length > 0 && name.every((w) => titel.has(w));
  });
  if (passend.length === 1) return passend[0];
  return chooseBook(passend, label, reference);
}

/** Buchflaeche ohne eindeutiges Produkt: Suchseite oder (Buch nicht im Laden) nichts. */
export const markOpenInternal = internalMutation({
  args: { id: v.id("pageLinks"), url: v.optional(v.string()) },
  handler: async (ctx, { id, url }) => {
    await ctx.db.patch(id, { url, resolvedAt: Date.now() });
  },
});

/** Einzelne Felder einer Flaeche setzen — fuer Werkzeuge mit Deploy-Schluessel. */
export const setFieldsInternal = internalMutation({
  args: {
    id: v.id("pageLinks"),
    single: v.optional(v.boolean()),
    url: v.optional(v.string()),
    queries: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { id, ...felder }) => {
    const patch: Record<string, unknown> = {};
    for (const [k, wert] of Object.entries(felder)) if (wert !== undefined) patch[k] = wert;
    await ctx.db.patch(id, patch);
  },
});

/** Die Aufloesung der `shop`-Flaechen eines Hefts verwerfen, damit sie neu laeuft. */
export const clearResolvedInternal = internalMutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const rows = await ctx.db
      .query("pageLinks")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    let n = 0;
    for (const r of rows) {
      if (r.kind === "shop" && r.url) {
        await ctx.db.patch(r._id, { url: undefined, resolvedAt: undefined });
        n++;
      }
    }
    return n;
  },
});

/**
 * Welche Suche eine Anzeige am besten zeigt.
 *
 * Eine Anzeige fuer ein Produkt (`single`): der erste Begriff, der genau ein
 * Produkt trifft, fuehrt auf dessen Seite; sonst die Suchseite des ersten
 * Begriffs mit Treffern. Eine Sammelanzeige fuehrt auf eine Liste: der
 * Begriff mit den meisten Treffern — ein mehrwortiger Begriff (der
 * Verfasser) geht vor, sobald er drei Treffer hat, damit nicht ein
 * einzelnes Wort mit allem Moeglichen gewinnt.
 */
export function chooseTarget(
  treffer: { q: string; products: ShopProduct[] }[],
  single: boolean,
): string | null {
  if (!treffer.length) return null;
  if (single) {
    const einziges = treffer.map((t) => chooseProduct(t.products)).find((p) => p);
    return einziges ? einziges.url : searchUrl(treffer[0].q);
  }
  const brauchbar = (t: { products: ShopProduct[] }) =>
    t.products.filter((p) => p.active && isShopUrl(p.url)).length;
  const mehrwortig = treffer.find((t) => t.q.trim().includes(" ") && brauchbar(t) >= 3);
  if (mehrwortig) return searchUrl(mehrwortig.q);
  const meiste = [...treffer].sort((a, b) => brauchbar(b) - brauchbar(a))[0];
  return brauchbar(meiste) > 0 ? searchUrl(meiste.q) : searchUrl(treffer[0].q);
}

// --- Einzelne Buecher -----------------------------------------------------------

/**
 * Trenner im `label` einer Buchflaeche: "Titel · Verfasser". Der Import legt
 * je Buch einer Bucherseite oder Besprechung eine eigene Flaeche an
 * (extract-service/extractor/buecher.py); an diesem Trenner erkennt die
 * Aufloesung sie und prueft den Titel streng (`chooseBook`).
 */
export const BOOK_LABEL_SEPARATOR = " · ";

const FUELLWOERTER = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "und",
  "oder", "mit", "von", "vom", "zum", "zur", "aus", "bei", "nach", "ueber",
  "fuer", "im", "in", "am", "an", "auf", "zu", "als", "wie",
]);

/** Kleinbuchstaben, ohne Akzente und Satzzeichen, ß als ss — wie im Worker. */
export function plainTitle(text: string): string {
  return text
    .replace(/ß/g, "ss")
    .replace(/\u2011/g, "-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Der Titel ohne Untertitel: bis zum Gedankenstrich oder Doppelpunkt. */
export function mainTitle(title: string): string {
  let t = title.replace(/\u2011/g, "-").replace(/\s+/g, " ").trim();
  for (const sep of [" – ", " — ", ": ", ". "]) {
    if (t.includes(sep)) {
      const head = t.split(sep)[0].trim();
      if (titleWords(head).length >= 1) t = head;
    }
  }
  return t.replace(/^[\s.,;:]+|[\s.,;:]+$/g, "");
}

function titleWords(text: string): string[] {
  return plainTitle(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !FUELLWOERTER.has(w));
}

/**
 * Wie gut ein Produktname zum Buchtitel passt: 3 gleich, 2 einer beginnt mit
 * dem anderen (Untertitel), 1 alle tragenden Woerter eines mehrwortigen
 * Titels im Namen, 0 nicht.
 * "STASI" passt zu "Stasi", "Der Stasi-Mythos" nicht.
 */
export function titleRank(productName: string, title: string): number {
  const name = plainTitle(productName);
  const head = plainTitle(mainTitle(title));
  const full = plainTitle(title);
  if (!head || !name) return 0;
  if (name === head || name === full) return 3;
  if (
    name.startsWith(`${head} `) ||
    name.startsWith(`${full} `) ||
    (head.startsWith(`${name} `) && name.includes(" "))
  ) {
    return 2;
  }
  const words = titleWords(mainTitle(title));
  const nameWords = new Set(titleWords(productName));
  // Ein einwortiger Titel ist darin zu leicht enthalten ("Stasi" in "Der
  // Stasi-Mythos"); er muss gleich sein oder am Anfang stehen.
  if (
    words.length >= 2 &&
    words.every((w) => nameWords.has(w)) &&
    nameWords.size <= words.length + 4
  ) {
    return 1;
  }
  return 0;
}

/** "Manfred Kleine-Hartlage", "Jake Tapper/Alex Thompson", "Pierre Drieu la Rochelle". */
export function looksLikeName(text: string): boolean {
  const t = text.replace(/\((?:Hrsg?|Hg)\.\)/g, "").trim();
  if (!t || t.length > 90 || /\d/.test(t)) return false;
  const words = t.split(/[\s/]+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  const particle = /^(?:von|van|de|du|da|del|la|le|zu|v\.)$/;
  const upper = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  return upper >= 2 && words.every((w) => /^\p{Lu}/u.test(w) || particle.test(w));
}

/**
 * Titel und Verfasser einer Buchflaeche. Der Import schreibt "Titel ·
 * Verfasser". Bei Anzeigen unter einem Artikel steht beides in einer Zeile
 * ("Manfred Kleine-Hartlage: BRD-Sprech"), der Verfasser fehlt im Label und
 * der Titel beginnt mit dem Namen. Dann ist der Teil vor dem Doppelpunkt der
 * Verfasser — aber nur, wenn er wie ein Name aussieht ("Kalender: ..." ist
 * eine Gattung, "2025: Verheimlicht ..." ein Jahrbuch).
 */
export function splitBookLabel(label: string): { title: string; author: string } {
  const [rawTitle, rawAuthor = ""] = label.split(BOOK_LABEL_SEPARATOR);
  const title = rawTitle.trim();
  const author = rawAuthor.trim();
  if (!author) {
    const at = title.indexOf(": ");
    if (at > 0 && looksLikeName(title.slice(0, at)) && titleWords(title.slice(at + 2)).length) {
      return { title: title.slice(at + 2).trim(), author: title.slice(0, at).trim() };
    }
  }
  return { title, author };
}

/**
 * Was nach "Wort. " im Titel steht ("Endspiel. Der Multikulticrash" →
 * "Der Multikulticrash"). Nur nach einem Punkt und nur, wenn davor keine
 * Zahl steht: "2025: Verheimlicht …" ist ein Jahrgang, den der Laden
 * vielleicht nicht fuehrt; ohne die Zahl traefe es einen anderen.
 */
function subtitles(title: string): string[] {
  const teile = title.split(/(?<=[.!?])\s+/);
  if (teile.length < 2 || /\d/.test(teile[0])) return [];
  // Zwei Woerter, davon eins tragend: "Der Multikulticrash" ja, "Teil 2" nein.
  return teile
    .slice(1)
    .filter((t) => plainTitle(t).split(" ").length >= 2 && titleWords(t).length >= 1);
}

function surname(author: string): string | null {
  const first = author.split(/[/,;&]| und /)[0].replace(/\((?:Hrsg?|Hg)\.\)/g, "").trim();
  const parts = first.split(/\s+/).filter((p) => /^[A-ZÄÖÜ]/.test(p) && p.length > 1);
  return parts.length ? parts[parts.length - 1].replace(/\.$/, "") : null;
}

/**
 * Suchbegriffe fuer den Laden ohne Satzzeichen. Die Ladensuche verlangt jedes
 * Wort der Anfrage im Produkt; ein Gedankenstrich ("DDR – CDU – AfD"),
 * Anfuehrungszeichen ("„Panther“") oder ein Komma am Wort fanden deshalb
 * nichts, obwohl das Buch im Laden steht.
 */
export function searchWords(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Die Anfragen fuer ein Buch: Artikelnummer, die Begriffe aus dem Import,
 * jeweils ohne Satzzeichen, und der Haupttitel allein (ohne Jahr und
 * Untertitel, die der Laden oft anders schreibt).
 */
export function bookQueries(
  label: string,
  reference: string | null,
  queries: string[],
): string[] {
  const { title, author } = splitBookLabel(label);
  const out = new Set<string>();
  const add = (q: string | null | undefined) => {
    const w = q ? searchWords(q) : "";
    if (w.length >= 2) out.add(w);
  };
  add(reference);
  for (const q of queries) add(q);
  // "Autor: Titel" im Label: der Titel allein und mit dem Nachnamen (der
  // Laden fuehrt den Verfasser im Herstellerfeld, das die Suche mitliest).
  const nachname = author ? surname(author) : null;
  if (author && !label.split(BOOK_LABEL_SEPARATOR)[1]?.trim()) {
    add(title);
    if (nachname) add(`${mainTitle(title)} ${nachname}`);
  }
  // Der Teil nach dem Punkt mit dem Verfasser ("Der Multikulticrash Reichel"):
  // so heisst das Buch manchmal im Laden (siehe `chooseBook`).
  if (nachname) {
    for (const teil of subtitles(title)) add(`${teil} ${nachname}`);
  }
  // Ein einzelnes Wort vor dem Doppelpunkt ("Kalender: Maenner der ...") ist
  // eine Gattung, kein Titel: allein gesucht passt es auf Dutzende Produkte,
  // und der richtige Treffer ginge im Gleichstand unter.
  if (titleWords(mainTitle(title)).length >= 2) {
    add(mainTitle(title));
    add(
      searchWords(mainTitle(title))
        .split(" ")
        .filter((w) => !/^\d+$/.test(w))
        .join(" "),
    );
  }
  return [...out];
}

/**
 * Das Produkt zu einer Buchflaeche. Mit Artikelnummer das Produkt mit genau
 * dieser Referenz. Sonst nur Produkte, deren Name zum Titel passt, die beste
 * Stufe zuerst; bleiben mehrere, entscheidet der Verfasser (Herstellerfeld).
 * Zwei Baende gleichen Namens bleiben offen — dann zeigt die Suchseite beide.
 */
export function chooseBook(
  products: ShopProduct[],
  label: string,
  reference?: string | null,
): ShopProduct | null {
  // Jede Anfrage liefert ihre Treffer; dasselbe Produkt kommt so mehrfach.
  // Doppelt gezaehlt war die Artikelnummer nie "genau eins" (DMZ-Zeitgeschichte
  // 80: "Soldatenköpfe 2026" verlor gegen das Produkt "Wolfgang Willrich").
  const einmal = new Map<string, ShopProduct>();
  for (const p of products) if (p.active && isShopUrl(p.url) && !einmal.has(p.url)) einmal.set(p.url, p);
  const brauchbar = [...einmal.values()];
  if (reference) {
    // Mit Artikelnummer nur genau dieses Produkt. Ein Titeltreffer mit
    // anderer Nummer ist ein anderer Jahrgang oder ein anderes Buch.
    const genau = brauchbar.filter((p) => p.reference === reference);
    return genau.length === 1 ? genau[0] : null;
  }
  const { title, author } = splitBookLabel(label);
  // "Kalender: Maenner der Waffen-SS 2026": vor dem Doppelpunkt steht die
  // Gattung, der Laden fuehrt den Teil danach als Namen.
  const titel = [title];
  const doppelpunkt = title.indexOf(": ");
  // Ein Jahrgang ("2025: Verheimlicht …") ist keine Gattung: ohne ihn traefe
  // der Titel jeden anderen Jahrgang.
  if (
    doppelpunkt > 0 &&
    titleWords(title.slice(0, doppelpunkt)).length < 2 &&
    !/\d/.test(title.slice(0, doppelpunkt))
  ) {
    titel.push(title.slice(doppelpunkt + 2));
  }
  // Nennt der Laden einen anderen Verfasser, ist es ein anderes Buch
  // ("Hybris" von Tapper/Thompson ist nicht "Hybris am Hindukusch" von
  // Michael Lueders). Ohne Herstellerfeld zaehlt nur der Titel.
  const verfasser = author ? surnames(author) : [];
  const vomVerfasser = (p: ShopProduct) => {
    const m = plainTitle(p.manufacturer);
    return verfasser.some((n) => m.split(" ").includes(n));
  };
  const ranked = new Map<string, { rank: number; product: ShopProduct }>();
  for (const p of brauchbar) {
    if (verfasser.length && plainTitle(p.manufacturer) && !vomVerfasser(p)) continue;
    // Der Laden fuehrt manchmal nur den Teil nach dem Punkt ("Endspiel. Der
    // Multikulticrash" heisst dort "Der Multikulticrash"). Das zaehlt nur,
    // wenn der Verfasser im Herstellerfeld steht.
    const teile = verfasser.length && vomVerfasser(p) ? subtitles(title) : [];
    const rank = Math.max(...[...titel, ...teile].map((t) => titleRank(p.name, t)));
    if (rank > 0) ranked.set(p.url, { rank, product: p });
  }
  if (!ranked.size) return null;
  const top = Math.max(...[...ranked.values()].map((r) => r.rank));
  let kandidaten = [...ranked.values()].filter((r) => r.rank === top).map((r) => r.product);
  if (kandidaten.length > 1 && verfasser.length) {
    const mit = kandidaten.filter(vomVerfasser);
    if (mit.length) kandidaten = mit;
  }
  // Dasselbe Buch zweimal im Laden (neue Auflage, gleicher Name, gleicher
  // Verfasser): die neuere Ausgabe, also die hoehere Produktnummer. Ohne
  // bestaetigten Verfasser bleibt es offen — gleichnamige Baende einer Reihe
  // haben einen Herausgeber, der in der Anzeige nicht steht.
  if (
    kandidaten.length > 1 &&
    verfasser.length &&
    kandidaten.every((p) => vomVerfasser(p) && plainTitle(p.name) === plainTitle(kandidaten[0].name))
  ) {
    return [...kandidaten].sort((a, b) => b.id - a.id)[0];
  }
  return kandidaten.length === 1 ? kandidaten[0] : null;
}

/** Nachnamen aller Verfasser, vereinfacht: "Gunter Frank/Martina Binnig" -> frank, binnig. */
function surnames(author: string): string[] {
  return author
    .replace(/\((?:Hrsg?|Hg)\.\)/g, " ")
    .split(/[/,;&]| und /)
    .map((n) => plainTitle(n).split(" ").filter((w) => w.length >= 3).pop() ?? "")
    .filter(Boolean);
}

/**
 * Ziel einer Buchflaeche ohne eindeutiges Produkt: die Suchseite des Titels,
 * wenn der Laden Buecher dieses Namens vom selben Verfasser fuehrt (Baende,
 * Ausgaben), sonst keins — eine leere Suchseite hilft niemandem.
 */
export function openBookTarget(products: ShopProduct[], label: string): string | undefined {
  const { title, author } = splitBookLabel(label);
  const verfasser = author ? surnames(author) : [];
  const aehnlich = products.some((p) => {
    if (!p.active || !isShopUrl(p.url) || titleRank(p.name, title) === 0) return false;
    const m = plainTitle(p.manufacturer);
    return !verfasser.length || !m || verfasser.some((n) => m.split(" ").includes(n));
  });
  return aehnlich ? searchUrl(searchWords(mainTitle(title))) : undefined;
}

export const setUrlInternal = internalMutation({
  args: { id: v.id("pageLinks"), url: v.string() },
  handler: async (ctx, { id, url }) => {
    await ctx.db.patch(id, { url, resolvedAt: Date.now() });
  },
});

const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000];

/**
 * Die `shop`-Flaechen eines Hefts im Laden aufloesen.
 *
 * Erst die Artikelnummer, dann die Suchbegriffe (`chooseTarget`). Findet
 * der Laden zu keinem Begriff etwas, bleibt die Flaeche bei der Suchseite
 * des ersten Begriffs (`zielAdresse`). Antwortet der Laden nicht, kommt der
 * Lauf spaeter wieder.
 */
export const resolveInternal = internalAction({
  args: { issueId: v.id("issues"), attempt: v.optional(v.number()) },
  handler: async (ctx, { issueId, attempt }): Promise<{ resolved: number; open: number } | null> => {
    if (!process.env.SHOP_WEBHOOK_SECRET) {
      console.log("pageLinks: SHOP_WEBHOOK_SECRET fehlt, keine Aufloesung im Laden");
      return null;
    }
    const rows: {
      id: Id<"pageLinks">;
      queries: string[];
      reference: string | null;
      single: boolean;
      label: string | null;
      fallback: ShopProduct[];
    }[] = await ctx.runQuery(internal.pageLinks.listUnresolvedInternal, { issueId });
    let resolved = 0;
    // Fuer das Protokoll: welche Buecher offen bleiben und warum.
    const offen: { label: string; ziel: "suche" | "keins" }[] = [];
    const cache = new Map<string, ShopProduct[]>();
    const search = async (q: string): Promise<ShopProduct[]> => {
      if (!cache.has(q)) cache.set(q, parseProducts(await callShopApi("search", { q })));
      return cache.get(q)!;
    };
    try {
      for (const row of rows) {
        let url: string | null = null;
        if (row.label?.includes(BOOK_LABEL_SEPARATOR)) {
          // Ein einzelnes Buch: nur ein Produkt mit passendem Titel — nie ein
          // beliebiger einziger Treffer der Suche.
          const products: ShopProduct[] = [];
          for (const q of bookQueries(row.label, row.reference, row.queries)) {
            products.push(...(await search(q)));
          }
          const buch =
            chooseBook(products, row.label, row.reference) ??
            // Sonst das Produkt, das der Abgleich der Anzeige darunter
            // gefunden hat (articleProducts: Titel woertlich in der Anzeige,
            // Preis bestaetigt).
            chooseFromAd(row.fallback, row.label, row.reference);
          if (buch) {
            await ctx.runMutation(internal.pageLinks.setUrlInternal, { id: row.id, url: buch.url });
            resolved++;
          } else {
            // Mehrere Baende oder Ausgaben gleichen Namens: die Suchseite des
            // Titels zeigt sie. Fuehrt der Laden das Buch gar nicht, fuehrt
            // die Flaeche nirgendwohin (der Tipp oeffnet die Anzeige), statt
            // auf eine leere Suchseite. Der naechste Lauf versucht es wieder.
            const ziel = openBookTarget(products, row.label);
            offen.push({ label: row.label.slice(0, 80), ziel: ziel ? "suche" : "keins" });
            await ctx.runMutation(internal.pageLinks.markOpenInternal, { id: row.id, url: ziel });
          }
          continue;
        }
        if (row.reference) {
          const treffer = chooseProduct(await search(row.reference), row.reference);
          if (treffer) url = treffer.url;
        }
        if (!url) {
          const treffer: { q: string; products: ShopProduct[] }[] = [];
          for (const q of row.queries) {
            const products = await search(q);
            if (products.length) treffer.push({ q, products });
          }
          url = chooseTarget(treffer, row.single);
        }
        if (url) {
          await ctx.runMutation(internal.pageLinks.setUrlInternal, { id: row.id, url });
          resolved++;
        }
      }
    } catch (error) {
      if (!(error instanceof ShopApiError)) throw error;
      const n = attempt ?? 0;
      if (n < RETRY_DELAYS_MS.length) {
        await ctx.scheduler.runAfter(RETRY_DELAYS_MS[n], internal.pageLinks.resolveInternal, {
          issueId,
          attempt: n + 1,
        });
      }
      console.error(
        JSON.stringify({ event: "pageLinks.shopFailed", issueId, attempt: n, error: error.message }),
      );
      return null;
    }
    console.log(
      JSON.stringify({
        event: "pageLinks.resolved",
        issueId,
        resolved,
        open: rows.length - resolved,
        openBooks: offen.slice(0, 40),
      }),
    );
    return { resolved, open: rows.length - resolved };
  },
});
