import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hasIssueAccess } from "./access";
import { Id } from "./_generated/dataModel";

export const get = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("readingProgress")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", userId as Id<"users">).eq("issueId", issueId),
      )
      .unique();
    if (!row) return null;
    return {
      mode: row.mode,
      pageIndex: row.pageIndex,
      articleId: row.articleId ?? null,
      updatedAt: row.updatedAt,
    };
  },
});

export const save = mutation({
  args: {
    issueId: v.id("issues"),
    mode: v.union(v.literal("page"), v.literal("article")),
    pageIndex: v.number(),
    articleId: v.optional(v.id("articles")),
  },
  handler: async (ctx, { issueId, mode, pageIndex, articleId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return;
    const existing = await ctx.db
      .query("readingProgress")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", userId as Id<"users">).eq("issueId", issueId),
      )
      .unique();
    const doc = {
      userId: userId as Id<"users">,
      issueId,
      mode,
      pageIndex,
      articleId,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("readingProgress", doc);
  },
});
