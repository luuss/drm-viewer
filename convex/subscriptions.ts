import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { hasActiveSubscription } from "./access";

/** Vom Stripe-Webhook gespiegelter Abo-Status. */
export const upsertFromStripe = internalMutation({
  args: {
    userId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    status: v.string(),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_stripe_subscription", (q) =>
        q.eq("stripeSubscriptionId", args.stripeSubscriptionId),
      )
      .unique();

    const userId = (args.userId ?? existing?.userId) as
      | Id<"users">
      | undefined;
    if (!userId) {
      console.warn(
        `Abo ${args.stripeSubscriptionId} ohne userId — kein Mapping moeglich`,
      );
      return null;
    }

    const doc = {
      userId,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId,
      status: args.status,
      currentPeriodEnd: args.currentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("subscriptions", doc);
  },
});

export const myStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { active: false, subscriptions: [] as any[] };
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return {
      active: await hasActiveSubscription(ctx, userId),
      subscriptions: subs.map((s) => ({
        _id: s._id,
        stripeSubscriptionId: s.stripeSubscriptionId,
        status: s.status,
        currentPeriodEnd: s.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
      })),
    };
  },
});

export const myCustomerId = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return sub?.stripeCustomerId ?? null;
  },
});

export const isOwnedBy = internalQuery({
  args: { userId: v.id("users"), stripeSubscriptionId: v.string() },
  handler: async (ctx, { userId, stripeSubscriptionId }) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_stripe_subscription", (q) =>
        q.eq("stripeSubscriptionId", stripeSubscriptionId),
      )
      .unique();
    return sub?.userId === userId;
  },
});

export const findUserByCustomer = internalQuery({
  args: { stripeCustomerId: v.string() },
  handler: async (ctx, { stripeCustomerId }) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_stripe_customer", (q) =>
        q.eq("stripeCustomerId", stripeCustomerId),
      )
      .first();
    return sub?.userId ?? null;
  },
});
