import { v } from "convex/values";
import {
  internalMutation,
  MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, requirePublisher, audit } from "./roles";
import { hasIssueAccess, accessibleIssueIds } from "./access";
import { blockType } from "./schema";
import { assetUrl } from "./assets";
import { Id } from "./_generated/dataModel";

const regionInput = v.object({
  pageIndex: v.number(),
  x0: v.number(),
  y0: v.number(),
  x1: v.number(),
  y1: v.number(),
  targetPageIndex: v.optional(v.number()),
  kind: v.optional(
    v.union(
      v.literal("body"),
      v.literal("title"),
      v.literal("image"),
      v.literal("other"),
    ),
  ),
});

const blockInput = v.object({
  order: v.number(),
  type: blockType,
  text: v.string(),
  sourcePageIndex: v.optional(v.number()),
  sourceY: v.optional(v.number()),
  sourceStoryId: v.optional(v.string()),
  sourceFrameId: v.optional(v.string()),
  styleName: v.optional(v.string()),
  confidence: v.optional(v.number()),
});

export const articleInput = v.object({
  order: v.number(),
  title: v.string(),
  subtitle: v.optional(v.string()),
  author: v.optional(v.string()),
  teaser: v.optional(v.string()),
  source: v.union(
    v.literal("idml"),
    v.literal("pdf"),
    v.literal("manual"),
    v.literal("hybrid"),
  ),
  confidence: v.optional(v.number()),
  primaryPageIndex: v.number(),
  pageStart: v.number(),
  pageEnd: v.number(),
  blocks: v.array(blockInput),
  regions: v.array(regionInput),
  images: v.optional(
    v.array(
      v.object({
        assetId: v.id("assets"),
        caption: v.optional(v.string()),
        sourcePageIndex: v.optional(v.number()),
        sourceY: v.optional(v.number()),
        afterBlockOrder: v.optional(v.number()),
      }),
    ),
  ),
});

/** Suchtext wird aus den Bloecken abgeleitet, nie getrennt gepflegt. */
async function rebuildSearchText(ctx: MutationCtx, articleId: Id<"articles">) {
  const article = await ctx.db.get(articleId);
  if (!article) return;
  const blocks = await ctx.db
    .query("articleBlocks")
    .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
    .collect();
  const parts = [article.title, article.subtitle ?? "", article.teaser ?? ""];
  for (const b of blocks) parts.push(b.text);
  await ctx.db.patch(articleId, {
    searchText: parts.filter(Boolean).join("\n\n").slice(0, 100000),
    updatedAt: Date.now(),
  });
}

async function recountIssue(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  await ctx.db.patch(issueId, { articleCount: rows.length, updatedAt: Date.now() });
}

async function renumber(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
    .collect();
  let i = 1;
  for (const r of rows) {
    if (r.order !== i) await ctx.db.patch(r._id, { order: i });
    i++;
  }
}

// --- Leser ---

export const listForReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    return rows
      .filter((a) => a.reviewStatus === "approved")
      .map((a) => ({
        _id: a._id,
        order: a.order,
        title: a.title,
        subtitle: a.subtitle ?? null,
        author: a.author ?? null,
        teaser: a.teaser ?? null,
        primaryPageIndex: a.primaryPageIndex,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
      }));
  },
});

/** Kleinste Klickflaeche, die noch Sinn ergibt (Anteil der Seitenkante). */
const MIN_REGION_SIZE = 0.004;
// Wie nah zwei Rahmen liegen duerfen, damit sie zu einer Klickflaeche
// zusammenwachsen. Knapp gehalten: Spaltenabstaende und der Abstand zum
// Nachbarartikel sind groesser, die Luecke zwischen Uberschrift und Text ist
// kleiner.
const REGION_GAP = 0.012;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Rechtecke desselben Artikels auf einer Seite zu wenigen Flaechen
// zusammenfassen: was sich beruehrt oder dicht beieinander liegt, wird ein
// Kasten. Die Liste ist kurz (Rahmen einer Seite), das quadratische Vorgehen
// also unkritisch.
function verschmelzen<T extends { x0: number; y0: number; x1: number; y1: number }>(
  rechtecke: T[],
): T[] {
  const offen = [...rechtecke];
  const fertig: T[] = [];
  while (offen.length > 0) {
    const gruppe = offen.shift()!;
    let gewachsen = true;
    while (gewachsen) {
      gewachsen = false;
      for (let i = offen.length - 1; i >= 0; i--) {
        const k = offen[i];
        const beruehrt =
          k.x0 <= gruppe.x1 + REGION_GAP &&
          k.x1 >= gruppe.x0 - REGION_GAP &&
          k.y0 <= gruppe.y1 + REGION_GAP &&
          k.y1 >= gruppe.y0 - REGION_GAP;
        if (!beruehrt) continue;
        gruppe.x0 = Math.min(gruppe.x0, k.x0);
        gruppe.y0 = Math.min(gruppe.y0, k.y0);
        gruppe.x1 = Math.max(gruppe.x1, k.x1);
        gruppe.y1 = Math.max(gruppe.y1, k.y1);
        offen.splice(i, 1);
        gewachsen = true;
      }
    }
    fertig.push(gruppe);
  }
  return fertig;
}

/** Klickflaechen im Seitenmodus, nur von freigegebenen Artikeln. */
export const regionsForReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const published = new Map<string, boolean>();
    type ReaderRegion = {
      articleId: Id<"articles">;
      pageIndex: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      kind: "body" | "title" | "image" | "other";
      targetPageIndex: number | null;
    };
    const navigation: ReaderRegion[] = [];
    const articleAreas = new Map<string, ReaderRegion[]>();
    for (const r of regions) {
      const key = r.articleId as string;
      if (!published.has(key)) {
        const a = await ctx.db.get(r.articleId);
        published.set(key, a?.reviewStatus === "approved");
      }
      if (!published.get(key)) continue;
      // Die Aufbereitung liefert vereinzelt verdrehte oder ueberstehende
      // Rechtecke (x0 groesser als x1, Werte ueber 1). Sortiert und auf die
      // Seite beschnitten kommen sie hier heraus; entartete Flaechen fallen
      // weg, statt im Reader als unsichtbare Fehlklickflaeche zu liegen.
      const x0 = clamp01(Math.min(r.x0, r.x1));
      const x1 = clamp01(Math.max(r.x0, r.x1));
      const y0 = clamp01(Math.min(r.y0, r.y1));
      const y1 = clamp01(Math.max(r.y0, r.y1));
      if (x1 - x0 < MIN_REGION_SIZE || y1 - y0 < MIN_REGION_SIZE) continue;
      const normalized: ReaderRegion = {
        articleId: r.articleId,
        pageIndex: r.pageIndex,
        x0,
        y0,
        x1,
        y1,
        kind: r.kind,
        targetPageIndex: r.targetPageIndex ?? null,
      };
      if (r.targetPageIndex !== undefined) {
        // Jeder TOC-Eintrag hat sein eigenes Sprungziel und darf nicht mit
        // benachbarten Zeilen zusammenfallen.
        navigation.push(normalized);
        continue;
      }

      // Die Debugansicht behaelt alle feinen Rohregionen. Im Reader werden
      // daraus wenige ruhige Flaechen: benachbarte Rahmen desselben Artikels
      // wachsen zusammen, entfernte bleiben getrennt. Ein einziger Kasten je
      // Artikel und Seite wuerde sonst bei zwei Artikeln auf einer Seite die
      // ganze Seite belegen und den Nachbarn verdecken.
      const areaKey = `${r.articleId}:${r.pageIndex}`;
      const bisher = articleAreas.get(areaKey);
      if (bisher) bisher.push({ ...normalized, kind: "body" });
      else articleAreas.set(areaKey, [{ ...normalized, kind: "body" }]);
    }
    const flaechen: ReaderRegion[] = [];
    for (const rohe of articleAreas.values()) {
      for (const teil of verschmelzen(rohe)) flaechen.push(teil);
    }
    return [...navigation, ...flaechen];
  },
});

export const getForReader = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const article = await ctx.db.get(articleId);
    if (!article) return null;
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, article.issueId))) {
      return null;
    }
    // Sichtbar sind freigegebene Artikel veroeffentlichter Ausgaben.
    if (article.reviewStatus !== "approved") return null;
    const issue = await ctx.db.get(article.issueId);
    if (!issue?.isPublished) return null;

    const blocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
      .collect();
    const images = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    const withUrls = [];
    for (const img of images.sort((a, b) => a.order - b.order)) {
      // Ueber `assetUrl`, damit auch Bilder aus dem Medienspeicher eine
      // Adresse bekommen — dort fuehrt der Weg ueber das Kachel-Gateway.
      const url = await assetUrl(ctx, img.assetId);
      if (url) {
        withUrls.push({
          url,
          caption: img.caption ?? null,
          page: img.sourcePageIndex ?? null,
          sourceY: img.sourceY ?? null,
          afterBlockOrder: img.afterBlockOrder ?? null,
        });
      }
    }
    return {
      _id: article._id,
      issueId: article.issueId,
      order: article.order,
      title: article.title,
      subtitle: article.subtitle ?? null,
      author: article.author ?? null,
      teaser: article.teaser ?? null,
      primaryPageIndex: article.primaryPageIndex,
      pageStart: article.pageStart,
      pageEnd: article.pageEnd,
      blocks: blocks.map((b) => ({
        type: b.type,
        text: b.text,
        page: b.sourcePageIndex ?? null,
        sourceY: b.sourceY ?? null,
      })),
      images: withUrls,
    };
  },
});

export const search = query({
  args: { term: v.string(), issueId: v.optional(v.id("issues")) },
  handler: async (ctx, { term, issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || term.trim().length < 3) return [];
    const allowed = await accessibleIssueIds(ctx, userId as Id<"users">);

    const hits = await ctx.db
      .query("articles")
      .withSearchIndex("search_text", (q) => {
        const base = q.search("searchText", term).eq("reviewStatus", "approved");
        return issueId ? base.eq("issueId", issueId) : base;
      })
      .take(60);

    const out = [];
    for (const a of hits) {
      if (!allowed.has(a.issueId as string)) continue;
      const issue = await ctx.db.get(a.issueId);
      if (!issue?.isPublished) continue;
      const idx = a.searchText.toLowerCase().indexOf(term.toLowerCase());
      const start = Math.max(0, idx - 70);
      out.push({
        _id: a._id,
        issueId: a.issueId,
        issueTitle: issue.title,
        title: a.title,
        pageIndex: a.primaryPageIndex,
        snippet:
          (start > 0 ? "..." : "") +
          a.searchText.slice(start, start + 220).replace(/\s+/g, " ") +
          "...",
      });
      if (out.length >= 25) break;
    }
    return out;
  },
});

// --- Redaktion ---

export const listForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    return Promise.all(
      rows.map(async (a) => {
        const blocks = await ctx.db
          .query("articleBlocks")
          .withIndex("by_article_order", (q) => q.eq("articleId", a._id))
          .collect();
        const regions = await ctx.db
          .query("articleRegions")
          .withIndex("by_article", (q) => q.eq("articleId", a._id))
          .collect();
        const images = await ctx.db
          .query("articleAssets")
          .withIndex("by_article", (q) => q.eq("articleId", a._id))
          .collect();
        return {
          _id: a._id,
          order: a.order,
          title: a.title,
          subtitle: a.subtitle ?? null,
          author: a.author ?? null,
          teaser: a.teaser ?? null,
          source: a.source,
          reviewStatus: a.reviewStatus,
          confidence: a.confidence ?? null,
          primaryPageIndex: a.primaryPageIndex,
          pageStart: a.pageStart,
          pageEnd: a.pageEnd,
          charCount: blocks.reduce((n, b) => n + b.text.length, 0),
          blocks: blocks.map((b) => ({
            _id: b._id,
            order: b.order,
            type: b.type,
            text: b.text,
            sourcePageIndex: b.sourcePageIndex ?? null,
          })),
          regions: regions.map((r) => ({
            _id: r._id,
            pageIndex: r.pageIndex,
            x0: r.x0,
            y0: r.y0,
            x1: r.x1,
            y1: r.y1,
            kind: r.kind,
            targetPageIndex: r.targetPageIndex ?? null,
          })),
          images: images
            .sort((left, right) => left.order - right.order)
            .map((image) => ({
              order: image.order,
              caption: image.caption ?? null,
              sourcePageIndex: image.sourcePageIndex ?? null,
              afterBlockOrder: image.afterBlockOrder ?? null,
            })),
        };
      }),
    );
  },
});

export const updateArticle = mutation({
  args: {
    articleId: v.id("articles"),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    author: v.optional(v.string()),
    teaser: v.optional(v.string()),
    primaryPageIndex: v.optional(v.number()),
  },
  handler: async (ctx, { articleId, ...patch }) => {
    await requireEditor(ctx);
    const clean: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    await ctx.db.patch(articleId, clean);
    await rebuildSearchText(ctx, articleId);
  },
});

export const updateBlock = mutation({
  args: {
    blockId: v.id("articleBlocks"),
    text: v.optional(v.string()),
    type: v.optional(blockType),
  },
  handler: async (ctx, { blockId, text, type }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) throw new Error("Block nicht gefunden");
    const clean: Record<string, unknown> = {};
    if (text !== undefined) clean.text = text;
    if (type !== undefined) clean.type = type;
    await ctx.db.patch(blockId, clean);
    await rebuildSearchText(ctx, block.articleId);
  },
});

export const deleteBlock = mutation({
  args: { blockId: v.id("articleBlocks") },
  handler: async (ctx, { blockId }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) return;
    await ctx.db.delete(blockId);
    await rebuildSearchText(ctx, block.articleId);
  },
});

/** Block innerhalb des Artikels verschieben oder in einen anderen Artikel. */
export const moveBlock = mutation({
  args: {
    blockId: v.id("articleBlocks"),
    targetArticleId: v.optional(v.id("articles")),
    direction: v.optional(v.union(v.literal("up"), v.literal("down"))),
  },
  handler: async (ctx, { blockId, targetArticleId, direction }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) throw new Error("Block nicht gefunden");

    if (targetArticleId && targetArticleId !== block.articleId) {
      const target = await ctx.db.get(targetArticleId);
      if (!target) throw new Error("Zielartikel nicht gefunden");
      if (target.issueId !== block.issueId) {
        throw new Error("Zielartikel gehoert zu einer anderen Ausgabe");
      }
      const targetBlocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", targetArticleId))
        .collect();
      await ctx.db.patch(blockId, {
        articleId: targetArticleId,
        order: targetBlocks.length + 1,
      });
      await rebuildSearchText(ctx, block.articleId);
      await rebuildSearchText(ctx, targetArticleId);
      return;
    }

    if (!direction) return;
    const siblings = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", block.articleId))
      .collect();
    const pos = siblings.findIndex((b) => b._id === blockId);
    const swapWith = direction === "up" ? pos - 1 : pos + 1;
    if (swapWith < 0 || swapWith >= siblings.length) return;
    const other = siblings[swapWith];
    await ctx.db.patch(blockId, { order: other.order });
    await ctx.db.patch(other._id, { order: block.order });
    await rebuildSearchText(ctx, block.articleId);
  },
});

export const mergeArticles = mutation({
  args: { targetId: v.id("articles"), sourceId: v.id("articles") },
  handler: async (ctx, { targetId, sourceId }) => {
    await requireEditor(ctx);
    const target = await ctx.db.get(targetId);
    const source = await ctx.db.get(sourceId);
    if (!target || !source) throw new Error("Artikel nicht gefunden");
    if (target.issueId !== source.issueId) {
      throw new Error("Artikel gehoeren zu verschiedenen Ausgaben");
    }

    const targetBlocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", targetId))
      .collect();
    const sourceBlocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", sourceId))
      .collect();
    let order = targetBlocks.length + 1;
    for (const b of sourceBlocks) {
      await ctx.db.patch(b._id, { articleId: targetId, order: order++ });
    }

    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_article", (q) => q.eq("articleId", sourceId))
      .collect();
    for (const r of regions) await ctx.db.patch(r._id, { articleId: targetId });

    const images = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", sourceId))
      .collect();
    for (const img of images) await ctx.db.patch(img._id, { articleId: targetId });

    await ctx.db.patch(targetId, {
      pageStart: Math.min(target.pageStart, source.pageStart),
      pageEnd: Math.max(target.pageEnd, source.pageEnd),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(sourceId);
    await rebuildSearchText(ctx, targetId);
    await renumber(ctx, target.issueId);
    await recountIssue(ctx, target.issueId);
    await audit(ctx, "article.merge", targetId, `aus ${sourceId}`);
  },
});

/**
 * Teilt an einer Blockgrenze. Regionen wandern anhand der Seiten der Bloecke
 * mit, statt beiden Teilen alle Flaechen zu vererben — genau der Fehler des
 * alten Zeichenversatz-Splits.
 */
export const splitAtBlock = mutation({
  args: {
    articleId: v.id("articles"),
    firstBlockOfSecond: v.id("articleBlocks"),
    newTitle: v.optional(v.string()),
  },
  handler: async (ctx, { articleId, firstBlockOfSecond, newTitle }) => {
    await requireEditor(ctx);
    const article = await ctx.db.get(articleId);
    if (!article) throw new Error("Artikel nicht gefunden");
    const blocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
      .collect();
    const cut = blocks.findIndex((b) => b._id === firstBlockOfSecond);
    if (cut <= 0) throw new Error("Trennstelle liegt nicht innerhalb des Artikels");

    const head = blocks.slice(0, cut);
    const tail = blocks.slice(cut);
    const tailPages = new Set(
      tail.map((b) => b.sourcePageIndex).filter((p): p is number => p !== undefined),
    );
    const headPages = new Set(
      head.map((b) => b.sourcePageIndex).filter((p): p is number => p !== undefined),
    );

    const title =
      newTitle?.trim() ||
      tail.find((b) => b.type === "heading")?.text ||
      `${article.title} (Fortsetzung)`;

    const now = Date.now();
    const newId = await ctx.db.insert("articles", {
      issueId: article.issueId,
      order: article.order + 0.5,
      title: title.slice(0, 300),
      source: article.source,
      reviewStatus: "pending",
      primaryPageIndex: Math.min(...(tailPages.size ? [...tailPages] : [article.primaryPageIndex])),
      pageStart: Math.min(...(tailPages.size ? [...tailPages] : [article.pageStart])),
      pageEnd: Math.max(...(tailPages.size ? [...tailPages] : [article.pageEnd])),
      searchText: "",
      createdAt: now,
      updatedAt: now,
    });

    let order = 1;
    for (const b of tail) {
      await ctx.db.patch(b._id, { articleId: newId, order: order++ });
    }

    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const r of regions) {
      const inTail = tailPages.has(r.pageIndex);
      const inHead = headPages.has(r.pageIndex);
      if (inTail && !inHead) await ctx.db.patch(r._id, { articleId: newId });
    }

    const images = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const img of images) {
      if (img.sourcePageIndex !== undefined && tailPages.has(img.sourcePageIndex)) {
        await ctx.db.patch(img._id, { articleId: newId });
      }
    }

    if (headPages.size > 0) {
      await ctx.db.patch(articleId, {
        pageStart: Math.min(...headPages),
        pageEnd: Math.max(...headPages),
        updatedAt: now,
      });
    }

    await rebuildSearchText(ctx, articleId);
    await rebuildSearchText(ctx, newId);
    await renumber(ctx, article.issueId);
    await recountIssue(ctx, article.issueId);
    await audit(ctx, "article.split", articleId, `neu ${newId}`);
    return newId;
  },
});

export const moveRegion = mutation({
  args: { regionId: v.id("articleRegions"), targetArticleId: v.id("articles") },
  handler: async (ctx, { regionId, targetArticleId }) => {
    await requireEditor(ctx);
    const region = await ctx.db.get(regionId);
    const target = await ctx.db.get(targetArticleId);
    if (!region || !target) throw new Error("Nicht gefunden");
    if (region.issueId !== target.issueId) {
      throw new Error("Andere Ausgabe");
    }
    await ctx.db.patch(regionId, { articleId: targetArticleId });
  },
});

/**
 * Redaktionelle Entscheidung. Es gibt keinen eigenen Artikel-Publish: was
 * freigegeben ist, wird mit der Ausgabe sichtbar — und Aenderungen daran sind
 * bei einer veroeffentlichten Ausgabe sofort live.
 */
export const setReviewStatus = mutation({
  args: {
    articleId: v.id("articles"),
    reviewStatus: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("excluded"),
    ),
  },
  handler: async (ctx, { articleId, reviewStatus }) => {
    await requireEditor(ctx);
    await ctx.db.patch(articleId, { reviewStatus, updatedAt: Date.now() });
    await audit(ctx, `article.review.${reviewStatus}`, articleId);
  },
});

/**
 * Obergrenze je Aufruf. Nach dem Import stehen alle Artikel eines Hefts offen;
 * einzeln freigeben ist bei siebzig Artikeln unzumutbar. Eine Mutation darf
 * aber nicht unbegrenzt schreiben, deshalb der Deckel — was darueber liegt,
 * holt der naechste Aufruf.
 */
const APPROVE_ALL_LIMIT = 500;

/** Alle offenen Artikel einer Ausgabe auf einmal freigeben. */
export const approveAllPending = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const pendingQuery = () =>
      ctx.db
        .query("articles")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .filter((q) => q.eq(q.field("reviewStatus"), "pending"));

    const rows = await pendingQuery().take(APPROVE_ALL_LIMIT);
    const now = Date.now();
    for (const r of rows) {
      // Genau wie setReviewStatus: nur der Artikel wird angefasst. Die Zaehler
      // am Heft (articleCount) haengen an der Anzahl, nicht am Status, und
      // duerfen hier nicht angefasst werden.
      await ctx.db.patch(r._id, { reviewStatus: "approved", updatedAt: now });
    }

    // Nach dem Deckel kann noch etwas offen sein. Das meldet die Pruefansicht,
    // statt stillschweigend eine halb freigegebene Ausgabe zu hinterlassen.
    const remaining = (await pendingQuery().first()) !== null;
    await audit(
      ctx,
      "article.review.approveAll",
      issueId,
      `${rows.length} Artikel${remaining ? ", weitere offen" : ""}`,
    );
    return { approved: rows.length, remaining };
  },
});

/** Zaehlt offene Entscheidungen — das Veroeffentlichungs-Gate haengt daran. */
export const reviewSummary = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    return {
      total: rows.length,
      pending: rows.filter((r) => r.reviewStatus === "pending").length,
      approved: rows.filter((r) => r.reviewStatus === "approved").length,
      excluded: rows.filter((r) => r.reviewStatus === "excluded").length,
    };
  },
});

export const removeArticle = mutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    await requireEditor(ctx);
    const article = await ctx.db.get(articleId);
    if (!article) return;
    for (const table of ["articleBlocks", "articleRegions", "articleAssets"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_article", (q: any) => q.eq("articleId", articleId))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    await ctx.db.delete(articleId);
    await renumber(ctx, article.issueId);
    await recountIssue(ctx, article.issueId);
  },
});

// --- Import ---

export const replaceForIssueInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    replace: v.boolean(),
    articles: v.array(articleInput),
  },
  handler: async (ctx, { issueId, replace, articles }) => {
    if (replace) {
      const old = await ctx.db
        .query("articles")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .collect();
      for (const a of old) {
        for (const table of ["articleBlocks", "articleRegions", "articleAssets"] as const) {
          const rows = await ctx.db
            .query(table)
            .withIndex("by_article", (q: any) => q.eq("articleId", a._id))
            .collect();
          for (const r of rows) await ctx.db.delete(r._id);
        }
        await ctx.db.delete(a._id);
      }
    }

    const now = Date.now();
    for (const a of articles) {
      const searchText = [a.title, a.subtitle ?? "", a.teaser ?? "", ...a.blocks.map((b) => b.text)]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 100000);
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: a.order,
        title: a.title.slice(0, 300),
        subtitle: a.subtitle,
        author: a.author,
        teaser: a.teaser,
        source: a.source,
        // Import landet immer als offene Entscheidung, nichts geht ungeprueft live.
        reviewStatus: "pending",
        confidence: a.confidence,
        primaryPageIndex: a.primaryPageIndex,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
        searchText,
        createdAt: now,
        updatedAt: now,
      });
      for (const b of a.blocks) {
        await ctx.db.insert("articleBlocks", {
          articleId,
          issueId,
          order: b.order,
          type: b.type,
          text: b.text,
          sourcePageIndex: b.sourcePageIndex,
          sourceY: b.sourceY,
          sourceStoryId: b.sourceStoryId,
          sourceFrameId: b.sourceFrameId,
          styleName: b.styleName,
          confidence: b.confidence,
        });
      }
      for (const [i, r] of a.regions.entries()) {
        await ctx.db.insert("articleRegions", {
          articleId,
          issueId,
          pageIndex: r.pageIndex,
          x0: r.x0,
          y0: r.y0,
          x1: r.x1,
          y1: r.y1,
          kind: r.kind ?? "body",
          order: i,
        });
      }
      for (const [i, img] of (a.images ?? []).entries()) {
        await ctx.db.insert("articleAssets", {
          articleId,
          issueId,
          assetId: img.assetId,
          order: i,
          caption: img.caption,
          sourcePageIndex: img.sourcePageIndex,
          sourceY: img.sourceY,
          afterBlockOrder: img.afterBlockOrder,
        });
      }
    }

    const all = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    await ctx.db.patch(issueId, { articleCount: all.length, updatedAt: now });
    return all.length;
  },
});
