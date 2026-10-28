import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { accessibleIssueIds } from "./access";
import { assetUrl } from "./assets";
import { shopLabels } from "./issues";
import { issueShopSku } from "./shopLinks";
import { Doc, Id } from "./_generated/dataModel";
import { passt, suchwoerter } from "./suche";

/**
 * Ist die Leserseite ein Umschlag (U1 oder U4)? Die erste Leserseite ist
 * immer der Titel (`spreadStart` im Reader), auch wenn ein alter Import ihr
 * keine Rolle mitgab.
 */
export function istUmschlag(page: Pick<Doc<"issuePages">, "index" | "role" | "printedLabel">) {
  return (
    page.index === 0 ||
    page.role === "front_cover" ||
    page.role === "back_cover" ||
    /^U\s*[14]$/i.test(page.printedLabel?.trim() ?? "")
  );
}

/**
 * Leserseiten, auf denen das gedruckte Inhaltsverzeichnis steht. Erkennbar an
 * den Klickflaechen des Verzeichnisses: nur sie tragen eine Zielseite. Ein
 * Heft ohne gedrucktes Verzeichnis (eine Monographie) hat keine.
 *
 * Der Umschlag zaehlt nicht mit, auch wenn er Sprungflaechen hat: die
 * Anreisser auf dem Titel von ZUERST! fuehren zu ihren Artikeln. Mit ihnen
 * zeigte die Heftseite von ZUERST! 1/2025 bis 6/2025 den Titel ein zweites
 * Mal als "Inhaltsverzeichnis, Seite 1".
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
  const out = [];
  for (const index of [...seiten].sort((a, b) => a - b)) {
    const page = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId).eq("index", index))
      .unique();
    if (!istUmschlag(page ?? { index, role: "content" })) out.push(index);
  }
  return out;
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
 * Suche in allen veroeffentlichten Heften, auch ohne Anmeldung: in den
 * Verzeichnissen und im Volltext. Hefte mit Zugriff fehlen hier, deren
 * Treffer kommen mit Ausschnitt aus `articles.search`. Von allen anderen
 * verlaesst kein Text aus dem Artikel den Server: ein Treffer nennt nur den
 * Titel (wie im Verzeichnis), die Unterzeile, wenn der Artikel im Verzeichnis
 * steht, und die Seite. Die Treffer sind nach Heft gebuendelt, damit man vom
 * Schlagwort direkt zum Heft und in den Warenkorb kommt.
 */
export const searchCatalog = query({
  args: { term: v.string() },
  handler: async (ctx, { term }) => {
    const begriff = term.trim();
    const woerter = suchwoerter(begriff);
    if (begriff.length < 3 || !woerter) return [];
    const userId = await getAuthUserId(ctx);
    const freigeschaltet = userId
      ? await accessibleIssueIds(ctx, userId as Id<"users">)
      : new Set<string>();

    // Treffer im Titel eines Verzeichniseintrags und im Text der Artikel.
    // Der Index verknuepft Woerter mit ODER; erst `passt` verlangt alle.
    const imTitel = (
      await ctx.db
        .query("tocEntries")
        .withSearchIndex("search_label", (q) => q.search("label", woerter))
        .take(40)
    ).filter((e) => passt(e.label, begriff));
    const imText = (
      await ctx.db
        .query("searchChunks")
        .withSearchIndex("search_text", (q) => q.search("text", woerter))
        .take(64)
    ).filter((c) => !freigeschaltet.has(c.issueId as string) && passt(c.text, begriff));

    const verzeichnisse = new Map<string, Doc<"tocEntries">[]>();
    const verzeichnis = async (issueId: Id<"issues">) => {
      let rows = verzeichnisse.get(issueId as string);
      if (!rows) {
        rows = await ctx.db
          .query("tocEntries")
          .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
          .collect();
        verzeichnisse.set(issueId as string, rows);
      }
      return rows;
    };

    type Kandidat = {
      key: string;
      issueId: Id<"issues">;
      label: string;
      section: string | null;
      pageIndex: number | null;
      articleId: Id<"articles"> | null;
      imText: boolean;
    };
    const kandidaten: Kandidat[] = imTitel.map((e) => ({
      key: e._id as string,
      issueId: e.issueId,
      label: e.label,
      section: e.section ?? null,
      pageIndex: e.pageIndex ?? null,
      articleId: e.articleId ?? null,
      imText: false,
    }));
    for (const c of imText) {
      // Steht der Artikel im Verzeichnis, erscheint er mit dessen Eintrag.
      const eintrag = (await verzeichnis(c.issueId)).find((t) => t.articleId === c.articleId);
      kandidaten.push({
        key: (eintrag?._id ?? c.articleId) as string,
        issueId: c.issueId,
        label: eintrag?.label ?? c.title,
        section: eintrag?.section ?? null,
        pageIndex: eintrag?.pageIndex ?? c.pageIndex,
        articleId: c.articleId,
        imText: true,
      });
    }

    const hefte = new Map<
      string,
      {
        issue: Doc<"issues">;
        entries: {
          _id: string;
          label: string;
          subtitle: string | null;
          section: string | null;
          page: string | null;
          imText: boolean;
        }[];
      }
    >();
    const ausgelassen = new Set<string>();
    const gesehen = new Set<string>();
    for (const e of kandidaten) {
      const key = e.issueId as string;
      if (ausgelassen.has(key) || gesehen.has(e.key)) continue;
      // Derselbe Artikel ueber Titel und Text: nur einmal.
      if (e.articleId && gesehen.has(e.articleId as string)) continue;
      gesehen.add(e.key);
      if (e.articleId) gesehen.add(e.articleId as string);
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
        e.pageIndex !== null
          ? await ctx.db
              .query("issuePages")
              .withIndex("by_issue_index", (q) =>
                q.eq("issueId", e.issueId).eq("index", e.pageIndex!),
              )
              .unique()
          : null;
      // Die Unterzeile steht im gedruckten Verzeichnis und ist so frei wie
      // dieses, aber nur, wenn der Artikel dort steht.
      const imVerzeichnis =
        e.articleId !== null &&
        (await verzeichnis(e.issueId)).some((t) => t.articleId === e.articleId);
      // Aus einem Stueck, nicht aus dem Artikel: der waere bis 100 kB gross.
      const stueck = imVerzeichnis
        ? await ctx.db
            .query("searchChunks")
            .withIndex("by_article", (q) => q.eq("articleId", e.articleId!))
            .first()
        : null;
      heft.entries.push({
        _id: e.key,
        label: e.label,
        subtitle: stueck?.subtitle?.trim() || null,
        section: e.section,
        page: seite?.printedLabel ?? null,
        imText: e.imText,
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
