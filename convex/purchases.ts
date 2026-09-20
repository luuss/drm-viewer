import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const recordPaid = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    email: v.string(),
    bookId: v.optional(v.id("books")),
    planId: v.optional(v.id("subscriptionPlans")),
    stripeSessionId: v.string(),
    stripePaymentIntentId: v.optional(v.string()),
    amountCents: v.number(),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("purchases")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeSessionId", args.stripeSessionId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { status: "paid" });
      return existing._id;
    }
    return await ctx.db.insert("purchases", {
      userId: args.userId,
      email: args.email,
      bookId: args.bookId,
      planId: args.planId,
      stripeSessionId: args.stripeSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      amountCents: args.amountCents,
      currency: args.currency,
      status: "paid",
      createdAt: Date.now(),
    });
  },
});

export const markRefunded = internalMutation({
  args: { stripePaymentIntentId: v.string() },
  handler: async (ctx, { stripePaymentIntentId }) => {
    const rows = await ctx.db.query("purchases").collect();
    const row = rows.find(
      (r) => r.stripePaymentIntentId === stripePaymentIntentId,
    );
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "refunded" });
    // Rueckerstattung entzieht den Zugriff auf das Einzelheft.
    if (row.userId && row.bookId) {
      const ent = await ctx.db
        .query("entitlements")
        .withIndex("by_user_book", (q) =>
          q.eq("userId", row.userId!).eq("bookId", row.bookId!),
        )
        .first();
      if (ent && ent.source === "purchase") await ctx.db.delete(ent._id);
    }
    return row._id;
  },
});

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    return Promise.all(
      rows.map(async (r) => ({
        _id: r._id,
        title: r.bookId ? (await ctx.db.get(r.bookId))?.title ?? null : null,
        planName: r.planId ? (await ctx.db.get(r.planId))?.name ?? null : null,
        amountCents: r.amountCents,
        currency: r.currency,
        status: r.status,
        createdAt: r.createdAt,
      })),
    );
  },
});
