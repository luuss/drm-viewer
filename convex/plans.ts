import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin } from "./admin";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const plans = await ctx.db.query("subscriptionPlans").collect();
    return plans
      .filter((p) => p.isActive)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("subscriptionPlans").collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    stripePriceId: v.string(),
    priceCents: v.number(),
    currency: v.optional(v.string()),
    interval: v.union(v.literal("month"), v.literal("year")),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("subscriptionPlans", {
      name: args.name,
      description: args.description,
      stripePriceId: args.stripePriceId,
      priceCents: args.priceCents,
      currency: args.currency ?? "eur",
      interval: args.interval,
      isActive: true,
      sortOrder: args.sortOrder,
      createdAt: Date.now(),
    });
  },
});

export const setActive = mutation({
  args: { planId: v.id("subscriptionPlans"), isActive: v.boolean() },
  handler: async (ctx, { planId, isActive }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(planId, { isActive });
  },
});

export const remove = mutation({
  args: { planId: v.id("subscriptionPlans") },
  handler: async (ctx, { planId }) => {
    await requireAdmin(ctx);
    await ctx.db.delete(planId);
  },
});

export const get = query({
  args: { planId: v.id("subscriptionPlans") },
  handler: async (ctx, { planId }) => await ctx.db.get(planId),
});
