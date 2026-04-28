import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const save = mutation({
  args: { bookId: v.id("books"), page: v.number() },
  handler: async (ctx, { bookId, page }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const ent = await ctx.db
      .query("entitlements")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .first();
    if (!ent) throw new Error("Kein Zugriff");

    const existing = await ctx.db
      .query("readingProgress")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { page, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("readingProgress", {
        userId,
        bookId,
        page,
        updatedAt: Date.now(),
      });
    }
  },
});

export const get = query({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return 0;
    const row = await ctx.db
      .query("readingProgress")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .unique();
    return row?.page ?? 0;
  },
});
