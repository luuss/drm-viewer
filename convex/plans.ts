import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin, audit } from "./roles";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const plans = await ctx.db.query("subscriptionPlans").collect();
    const active = plans.filter((p) => p.isActive);
    active.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return Promise.all(
      active.map(async (p) => ({
        _id: p._id,
        name: p.name,
        description: p.description ?? null,
        priceAmountCents: p.priceAmountCents,
        interval: p.interval,
        publicationId: p.publicationId,
        publication: (await ctx.db.get(p.publicationId))?.name ?? null,
      })),
    );
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
    publicationId: v.id("publications"),
    stripePriceId: v.string(),
    priceAmountCents: v.number(),
    interval: v.union(v.literal("month"), v.literal("year")),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = await ctx.db.insert("subscriptionPlans", {
      ...args,
      isActive: true,
      createdAt: Date.now(),
    });
    await audit(ctx, "plan.create", id, args.name);
    return id;
  },
});

export const setActive = mutation({
  args: { planId: v.id("subscriptionPlans"), isActive: v.boolean() },
  handler: async (ctx, { planId, isActive }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(planId, { isActive });
  },
});

export const get = query({
  args: { planId: v.id("subscriptionPlans") },
  handler: async (ctx, { planId }) => await ctx.db.get(planId),
});
