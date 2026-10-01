import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { accessibleIssueIds } from "./access";
import { assetUrl } from "./assets";
import { shopLabels } from "./issues";
import { issueShopSku } from "./shopLinks";
import { Doc, Id } from "./_generated/dataModel";

/**
 * Leserseiten, auf denen das gedruckte Inhaltsverzeichnis steht. Erkennbar an
 * den Klickflaechen des Verzeichnisses: nur sie tragen eine Zielseite. Ein
 * Heft ohne gedrucktes Verzeichnis (eine Monographie) hat keine.
 */
export async function tocPageIndices(
  ctx: QueryCtx,
  issueId: Id<"issues">,
): Promise<number[]> {
  const regions = await ctx.db
    .query("articleRegions")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const seiten = new Set<number>();
  for (const r of regions) {
    if (r.targetPageIndex !== undefined) seiten.add(r.pageIndex);
  }
  return [...seiten].sort((a, b) => a - b);
}

/** Gerenderte Bilder der Verzeichnisseiten, wie sie das Kachel-Gateway auch hat. */
export async function tocPageAssets(
  ctx: QueryCtx,
  issueId: Id<"issues">,
): Promise<{ index: number; asset: Doc<"assets"> }[]> {
  const out = [];
  for (const index of await tocPageIndices(ctx, issueId)) {
    const page = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId).eq("index", index))
      .unique();
    if (!page?.previewKey) continue;
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_key", (q) => q.eq("key", page.previewKey!))
      .first();
    if (asset) out.push({ index, asset });
  }
  return out;
}

/**
 * Das Verzeichnis eines veroeffentlichten Hefts steht im Kiosk, wie das
 * Titelbild: es ist die Auslage, nicht der bezahlte Inhalt. Alle anderen
 * Seiten bleiben hinter der Lesesitzung.
 */
export async function isPublicTocPage(ctx: QueryCtx, asset: Doc<"assets">) {
  if (asset.kind !== "page" || !asset.issueId) return false;
  const issue = await ctx.db.get(asset.issueId);
  if (!issue?.isPublished) return false;
  const seiten = await tocPageAssets(ctx, asset.issueId);
  return seiten.some((s) => s.asset._id === asset._id);
}

/** Bilder fuer die Heftvorschau im Kiosk, in Leserfolge. */
export async function tocImages(ctx: QueryCtx, issueId: Id<"issues">) {
  const out = [];
  for (const { index, asset } of await tocPageAssets(ctx, issueId)) {
    const url = await assetUrl(ctx, asset._id);
    if (!url) continue;
    out.push({
      pageIndex: index,
      url,
      width: asset.width ?? null,
      height: asset.height ?? null,
    });
  }
  return out;
}

/**
 * Suche in den Inhaltsverzeichnissen aller veroeffentlichten Hefte, auch ohne
 * Anmeldung. Hefte mit Zugriff fehlen hier: deren ganzer Text kommt aus
 * `articles.search`. Die Treffer sind nach Heft gebuendelt, damit man vom
 * Schlagwort direkt zum Heft und in den Warenkorb kommt.
 */
export const searchCatalog = query({
  args: { term: v.string() },
  handler: async (ctx, { term }) => {
    const begriff = term.trim();
    if (begriff.length < 3) return [];
    const userId = await getAuthUserId(ctx);
    const freigeschaltet = userId
      ? await accessibleIssueIds(ctx, userId as Id<"users">)
      : new Set<string>();

    const hits = await ctx.db
      .query("tocEntries")
      .withSearchIndex("search_label", (q) => q.search("label", begriff))
      .take(80);

    const hefte = new Map<
      string,
      {
        issue: Doc<"issues">;
        entries: { _id: Id<"tocEntries">; label: string; section: string | null; page: string | null }[];
      }
    >();
    const ausgelassen = new Set<string>();
    for (const e of hits) {
      const key = e.issueId as string;
      if (ausgelassen.has(key)) continue;
      let heft = hefte.get(key);
      if (!heft) {
        const issue = await ctx.db.get(e.issueId);
        if (!issue?.isPublished || freigeschaltet.has(key)) {
          ausgelassen.add(key);
          continue;
        }
        heft = { issue, entries: [] };
        hefte.set(key, heft);
      }
      // Gedruckte Seitenzahl, nicht die Stelle in der Leserfolge.
      const seite =
        e.pageIndex !== undefined
          ? await ctx.db
              .query("issuePages")
              .withIndex("by_issue_index", (q) =>
                q.eq("issueId", e.issueId).eq("index", e.pageIndex!),
              )
              .unique()
          : null;
      heft.entries.push({
        _id: e._id,
        label: e.label,
        section: e.section ?? null,
        page: seite?.printedLabel ?? null,
      });
    }

    const out = [];
    for (const { issue, entries } of hefte.values()) {
      const publication = await ctx.db.get(issue.publicationId);
      out.push({
        _id: issue._id,
        slug: issue.slug,
        publicationName: publication?.name ?? null,
        ...shopLabels(issue, publication?.name ?? null),
        coverUrl: await assetUrl(ctx, issue.coverAssetId),
        priceAmountCents: issue.priceAmountCents,
        shopSku: issueShopSku(issue),
        entries: entries.slice(0, 6),
        more: Math.max(0, entries.length - 6),
      });
    }
    return out;
  },
});
