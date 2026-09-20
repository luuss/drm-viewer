import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAdmin } from "./admin";
import { hasBookAccess } from "./access";
import { Id } from "./_generated/dataModel";

const boxValidator = v.object({
  page: v.number(),
  x0: v.number(),
  y0: v.number(),
  x1: v.number(),
  y1: v.number(),
});

/** Artikelumrisse fuer den Seitenmodus: Klickflaechen ueber dem Kachelbild. */
export const listForBook = query({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasBookAccess(ctx, userId, bookId))) return [];
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_book_order", (q) => q.eq("bookId", bookId))
      .collect();
    return rows
      .filter((a) => a.status === "published")
      .map((a) => ({
        _id: a._id,
        order: a.order,
        title: a.title,
        subtitle: a.subtitle ?? null,
        author: a.author ?? null,
        teaser: a.teaser ?? null,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
        boxes: a.boxes,
      }));
  },
});

export const getArticle = query({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const a = await ctx.db.get(articleId);
    if (!a) return null;
    if (a.status !== "published") {
      // Entwuerfe sieht nur die Redaktion.
      await requireAdmin(ctx);
    } else if (!(await hasBookAccess(ctx, userId, a.bookId))) {
      return null;
    }
    const images = await Promise.all(
      (a.images ?? []).map(async (img) => ({
        url: await ctx.storage.getUrl(img.storageId),
        page: img.page,
        caption: img.caption ?? null,
      })),
    );
    return {
      _id: a._id,
      bookId: a.bookId,
      title: a.title,
      subtitle: a.subtitle ?? null,
      author: a.author ?? null,
      text: a.text,
      pageStart: a.pageStart,
      pageEnd: a.pageEnd,
      images,
    };
  },
});

/** Volltextsuche ueber alle Ausgaben, auf die der Nutzer Zugriff hat. */
export const search = query({
  args: { term: v.string(), bookId: v.optional(v.id("books")) },
  handler: async (ctx, { term, bookId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || term.trim().length < 3) return [];

    const hits = await ctx.db
      .query("articles")
      .withSearchIndex("search_text", (q) => {
        const base = q.search("text", term).eq("status", "published");
        return bookId ? base.eq("bookId", bookId) : base;
      })
      .take(40);

    const allowed = new Map<string, boolean>();
    const out = [];
    for (const a of hits) {
      const key = a.bookId as string;
      if (!allowed.has(key)) {
        allowed.set(key, await hasBookAccess(ctx, userId, a.bookId));
      }
      if (!allowed.get(key)) continue;
      const book = await ctx.db.get(a.bookId);
      // Unveroeffentlichte Hefte tauchen auch nicht als Treffer auf.
      if (!book?.isPublished) continue;
      const idx = a.text.toLowerCase().indexOf(term.toLowerCase());
      const start = Math.max(0, idx - 60);
      out.push({
        _id: a._id,
        bookId: a.bookId,
        bookTitle: book?.title ?? "",
        title: a.title,
        pageStart: a.pageStart,
        snippet:
          (start > 0 ? "..." : "") +
          a.text.slice(start, start + 220).replace(/\s+/g, " ") +
          "...",
      });
      if (out.length >= 20) break;
    }
    return out;
  },
});

// --- Redaktion ---

export const listForAdmin = query({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("articles")
      .withIndex("by_book_order", (q) => q.eq("bookId", bookId))
      .collect();
  },
});

export const updateArticle = mutation({
  args: {
    articleId: v.id("articles"),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    author: v.optional(v.string()),
    teaser: v.optional(v.string()),
    text: v.optional(v.string()),
    order: v.optional(v.number()),
    pageStart: v.optional(v.number()),
    pageEnd: v.optional(v.number()),
    status: v.optional(v.union(v.literal("draft"), v.literal("published"))),
    boxes: v.optional(v.array(boxValidator)),
  },
  handler: async (ctx, { articleId, ...patch }) => {
    await requireAdmin(ctx);
    const clean: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    await ctx.db.patch(articleId, clean);
  },
});

export const deleteArticle = mutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    await requireAdmin(ctx);
    const a = await ctx.db.get(articleId);
    await ctx.db.delete(articleId);
    if (a) await recount(ctx, a.bookId);
  },
});

/** Zwei falsch getrennte Artikel wieder zusammenfuehren (haeufigster Korrekturfall). */
export const mergeArticles = mutation({
  args: { targetId: v.id("articles"), sourceId: v.id("articles") },
  handler: async (ctx, { targetId, sourceId }) => {
    await requireAdmin(ctx);
    const target = await ctx.db.get(targetId);
    const source = await ctx.db.get(sourceId);
    if (!target || !source) throw new Error("Artikel nicht gefunden");
    if (target.bookId !== source.bookId) {
      throw new Error("Artikel gehoeren zu verschiedenen Ausgaben");
    }
    await ctx.db.patch(targetId, {
      text: `${target.text}\n\n${source.text}`.trim(),
      pageStart: Math.min(target.pageStart, source.pageStart),
      pageEnd: Math.max(target.pageEnd, source.pageEnd),
      boxes: [...target.boxes, ...source.boxes],
      images: [...(target.images ?? []), ...(source.images ?? [])],
      updatedAt: Date.now(),
    });
    await ctx.db.delete(sourceId);
    await recount(ctx, target.bookId);
  },
});

/** Artikel an einer Textstelle teilen (falsch zusammengezogene Artikel). */
export const splitArticle = mutation({
  args: { articleId: v.id("articles"), splitAt: v.number(), newTitle: v.string() },
  handler: async (ctx, { articleId, splitAt, newTitle }) => {
    await requireAdmin(ctx);
    const a = await ctx.db.get(articleId);
    if (!a) throw new Error("Artikel nicht gefunden");
    if (splitAt <= 0 || splitAt >= a.text.length) {
      throw new Error("Teilungsstelle liegt ausserhalb des Textes");
    }
    const head = a.text.slice(0, splitAt).trim();
    const tail = a.text.slice(splitAt).trim();
    await ctx.db.patch(articleId, { text: head, updatedAt: Date.now() });
    await ctx.db.insert("articles", {
      bookId: a.bookId,
      order: a.order + 0.5,
      title: newTitle,
      text: tail,
      pageStart: a.pageStart,
      pageEnd: a.pageEnd,
      boxes: a.boxes,
      source: a.source,
      status: "draft",
      updatedAt: Date.now(),
    });
    await renumber(ctx, a.bookId);
    await recount(ctx, a.bookId);
  },
});

export const publishAll = mutation({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_book", (q) => q.eq("bookId", bookId))
      .collect();
    for (const r of rows) {
      if (r.status !== "published") {
        await ctx.db.patch(r._id, { status: "published", updatedAt: Date.now() });
      }
    }
    return rows.length;
  },
});

export const replaceForBookInternal = internalMutation({
  args: {
    bookId: v.id("books"),
    replace: v.boolean(),
    articles: v.array(
      v.object({
        order: v.number(),
        title: v.string(),
        subtitle: v.optional(v.string()),
        author: v.optional(v.string()),
        teaser: v.optional(v.string()),
        text: v.string(),
        pageStart: v.number(),
        pageEnd: v.number(),
        boxes: v.array(boxValidator),
        source: v.union(v.literal("idml"), v.literal("pdf"), v.literal("manual")),
      }),
    ),
  },
  handler: async (ctx, { bookId, replace, articles }) => {
    if (replace) {
      const old = await ctx.db
        .query("articles")
        .withIndex("by_book", (q) => q.eq("bookId", bookId))
        .collect();
      for (const o of old) await ctx.db.delete(o._id);
    }
    for (const a of articles) {
      await ctx.db.insert("articles", {
        bookId,
        order: a.order,
        title: a.title,
        subtitle: a.subtitle,
        author: a.author,
        teaser: a.teaser,
        text: a.text,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
        boxes: a.boxes,
        source: a.source,
        // Import landet als Entwurf — die Redaktion gibt frei.
        status: "draft",
        updatedAt: Date.now(),
      });
    }
    await recount(ctx, bookId);
    return articles.length;
  },
});

async function recount(ctx: any, bookId: Id<"books">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_book", (q: any) => q.eq("bookId", bookId))
    .collect();
  await ctx.db.patch(bookId, { articleCount: rows.length });
}

async function renumber(ctx: any, bookId: Id<"books">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_book_order", (q: any) => q.eq("bookId", bookId))
    .collect();
  let i = 1;
  for (const r of rows) {
    await ctx.db.patch(r._id, { order: i++ });
  }
}
