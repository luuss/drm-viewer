import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor } from "./roles";
import { hasIssueAccess } from "./access";
import { Id } from "./_generated/dataModel";

export const listForReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const rows = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    const out = [];
    for (const r of rows) {
      // Verweise auf unveroeffentlichte Artikel taugen nicht als Sprungziel.
      let articleId = r.articleId ?? null;
      if (articleId) {
        const article = await ctx.db.get(articleId);
        if (!article || article.reviewStatus !== "approved") articleId = null;
      }
      out.push({
        _id: r._id,
        order: r.order,
        label: r.label,
        section: r.section ?? null,
        pageIndex: r.pageIndex ?? null,
        articleId,
        level: r.level,
      });
    }
    return out;
  },
});

export const listForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    return await ctx.db
      .query("tocEntries")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
  },
});

export const upsert = mutation({
  args: {
    entryId: v.optional(v.id("tocEntries")),
    issueId: v.id("issues"),
    order: v.optional(v.number()),
    label: v.optional(v.string()),
    section: v.optional(v.string()),
    pageIndex: v.optional(v.number()),
    articleId: v.optional(v.id("articles")),
    level: v.optional(v.number()),
  },
  handler: async (ctx, { entryId, issueId, ...patch }) => {
    await requireEditor(ctx);
    if (entryId) {
      const clean: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(patch)) {
        if (val !== undefined) clean[k] = val;
      }
      await ctx.db.patch(entryId, clean);
      return entryId;
    }
    const existing = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    return await ctx.db.insert("tocEntries", {
      issueId,
      order: patch.order ?? existing.length + 1,
      label: patch.label ?? "Neuer Eintrag",
      section: patch.section,
      pageIndex: patch.pageIndex,
      articleId: patch.articleId,
      level: patch.level ?? 1,
    });
  },
});

export const remove = mutation({
  args: { entryId: v.id("tocEntries") },
  handler: async (ctx, { entryId }) => {
    await requireEditor(ctx);
    await ctx.db.delete(entryId);
  },
});

export const reorder = mutation({
  args: { issueId: v.id("issues"), orderedIds: v.array(v.id("tocEntries")) },
  handler: async (ctx, { orderedIds }) => {
    await requireEditor(ctx);
    let i = 1;
    for (const id of orderedIds) await ctx.db.patch(id, { order: i++ });
  },
});

/** Beim Import aus den erkannten Artikeln vorbefuellen. */
export const rebuildFromArticlesInternal = internalMutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const old = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const o of old) await ctx.db.delete(o._id);

    const articles = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    let order = 1;
    for (const a of articles) {
      if (a.reviewStatus === "excluded") continue;
      await ctx.db.insert("tocEntries", {
        issueId,
        order: order++,
        label: a.title,
        pageIndex: a.primaryPageIndex,
        articleId: a._id,
        level: 1,
      });
    }
    return articles.length;
  },
});
