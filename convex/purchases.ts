import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const recordPaid = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    email: v.string(),
    bookId: v.id("books"),
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
      stripeSessionId: args.stripeSessionId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      amountCents: args.amountCents,
      currency: args.currency,
      status: "paid",
      createdAt: Date.now(),
    });
  },
});
