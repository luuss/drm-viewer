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
  query,
  type MutationCtx,
} from "./_generated/server";
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

export const replaceImportedInternal = internalMutation({
  args: { issueId: v.id("issues"), links: v.array(pageLinkInput) },
  handler: async (ctx, { issueId, links }) => ({
    links: await replaceImportedLinks(ctx, issueId, links),
  }),
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
    return rows
      .filter((r) => r.kind === "shop" && !r.url)
      .map((r) => ({ id: r._id, queries: r.queries ?? [], reference: r.reference ?? null }));
  },
});

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
 * Erst die Artikelnummer. Dann die Suchbegriffe: trifft einer genau ein
 * Produkt, ist das die Produktseite; sonst zaehlt der erste Begriff, zu dem
 * der Laden etwas findet, mit seiner Suchseite. Findet der Laden zu keinem
 * Begriff etwas, bleibt die Flaeche bei der Suchseite des ersten Begriffs
 * (`zielAdresse`). Antwortet der Laden nicht, kommt der Lauf spaeter wieder.
 */
export const resolveInternal = internalAction({
  args: { issueId: v.id("issues"), attempt: v.optional(v.number()) },
  handler: async (ctx, { issueId, attempt }): Promise<{ resolved: number; open: number } | null> => {
    if (!process.env.SHOP_WEBHOOK_SECRET) {
      console.log("pageLinks: SHOP_WEBHOOK_SECRET fehlt, keine Aufloesung im Laden");
      return null;
    }
    const rows: { id: Id<"pageLinks">; queries: string[]; reference: string | null }[] =
      await ctx.runQuery(internal.pageLinks.listUnresolvedInternal, { issueId });
    let resolved = 0;
    const cache = new Map<string, ShopProduct[]>();
    const search = async (q: string): Promise<ShopProduct[]> => {
      if (!cache.has(q)) cache.set(q, parseProducts(await callShopApi("search", { q })));
      return cache.get(q)!;
    };
    try {
      for (const row of rows) {
        let url: string | null = null;
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
          const einziges = treffer.map((t) => chooseProduct(t.products)).find((p) => p);
          if (einziges) url = einziges.url;
          else if (treffer.length) url = searchUrl(treffer[0].q);
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
      JSON.stringify({ event: "pageLinks.resolved", issueId, resolved, open: rows.length - resolved }),
    );
    return { resolved, open: rows.length - resolved };
  },
});
