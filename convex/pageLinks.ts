/**
 * Klickflaechen auf einer Seite, die nicht zu einem Artikel fuehren, sondern
 * nach draussen.
 *
 * Der Abo-Aufruf auf U2 oder U3 ist kein Lesetext: ein Tipp darauf oeffnet
 * gleich das Abo-Formular der beworbenen Reihe im Laden, im neuen Tab und
 * ohne Zwischenfrage. Der Import legt diese Flaechen an (`source: "import"`,
 * bei jedem Lauf ersetzt); die Redaktion kann eigene dazulegen, die bleiben.
 * Eine `subscription`-Flaeche nennt nur die Reihe; die Adresse kommt beim
 * Lesen aus `publications.shopPrintSubscriptionUrl` oder, ohne Eintrag, aus
 * dem bekannten Formular des Ladens.
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import { hasIssueAccess } from "./access";
import { Id } from "./_generated/dataModel";
import { SHOP_URL } from "./shopCovers";

export const pageLinkInput = v.object({
  pageIndex: v.number(),
  x0: v.number(),
  y0: v.number(),
  x1: v.number(),
  y1: v.number(),
  kind: v.union(v.literal("subscription"), v.literal("url")),
  publicationSlug: v.optional(v.string()),
  url: v.optional(v.string()),
  label: v.optional(v.string()),
});

type PageLinkInput = {
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: "subscription" | "url";
  publicationSlug?: string;
  url?: string;
  label?: string;
};

/** Das Abo-Formular einer Reihe im Laden, solange die Redaktion keins eintraegt. */
export function defaultSubscriptionUrl(slug: string): string {
  return `${SHOP_URL}/module/luszeitformulare/formular?f=abo-${slug}`;
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
      let url = row.url ?? null;
      if (row.kind === "subscription" && row.publicationSlug) {
        const slug = row.publicationSlug;
        if (!adressen.has(slug)) {
          const publication = await ctx.db
            .query("publications")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .unique();
          adressen.set(
            slug,
            publication?.shopPrintSubscriptionUrl || defaultSubscriptionUrl(slug),
          );
        }
        url = adressen.get(slug) ?? null;
      }
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
