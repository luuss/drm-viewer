import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { entitlementSource } from "./schema";
import { requirePublisher, audit } from "./roles";
import { Id } from "./_generated/dataModel";

export const grantInternal = internalMutation({
  args: {
    userId: v.id("users"),
    issueId: v.id("issues"),
    source: entitlementSource,
    stripeSessionId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
    validUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", args.userId).eq("issueId", args.issueId),
      )
      .first();
    if (existing) {
      // Ein bestehender unbefristeter Zugang wird nicht verschlechtert.
      if (existing.validUntil !== undefined && args.validUntil === undefined) {
        await ctx.db.patch(existing._id, { validUntil: undefined });
      }
      return existing._id;
    }
    return await ctx.db.insert("entitlements", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const revokeInternal = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    issueId: v.id("issues"),
    email: v.optional(v.string()),
    onlySources: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, issueId, email, onlySources }) => {
    let targetUserId = userId ?? null;
    if (!targetUserId && email) {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email.toLowerCase()))
        .first();
      targetUserId = (user?._id as Id<"users">) ?? null;
    }
    if (!targetUserId) return 0;

    const rows = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", targetUserId as Id<"users">).eq("issueId", issueId),
      )
      .collect();
    let n = 0;
    for (const r of rows) {
      if (onlySources && !onlySources.includes(r.source)) continue;
      await ctx.db.delete(r._id);
      n++;
    }
    return n;
  },
});

/** Freischaltung von Hand, etwa fuer Rezensionsexemplare. */
export const grantByEmail = mutation({
  args: { issueId: v.id("issues"), email: v.string() },
  handler: async (ctx, { issueId, email }) => {
    await requirePublisher(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.toLowerCase()))
      .first();
    if (!user) {
      throw new Error(
        "Kein Konto mit dieser Adresse. Bitte den Gutschein-Weg nutzen.",
      );
    }
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", user._id as Id<"users">).eq("issueId", issueId),
      )
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert("entitlements", {
      userId: user._id as Id<"users">,
      issueId,
      source: "admin",
      createdAt: Date.now(),
    });
    await audit(ctx, "entitlement.grant", issueId, email);
    return id;
  },
});

export const grantMyself = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await requirePublisher(ctx);
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", userId).eq("issueId", issueId),
      )
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert("entitlements", {
      userId,
      issueId,
      source: "admin",
      createdAt: Date.now(),
    });
    await audit(ctx, "entitlement.grantSelf", issueId);
    return id;
  },
});

export const revokeByEmail = mutation({
  args: { issueId: v.id("issues"), email: v.string() },
  handler: async (ctx, { issueId, email }) => {
    await requirePublisher(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.toLowerCase()))
      .first();
    if (!user) return 0;
    const rows = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", user._id as Id<"users">).eq("issueId", issueId),
      )
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    await audit(ctx, "entitlement.revoke", issueId, email);
    return rows.length;
  },
});
