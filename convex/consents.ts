import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/** Aktueller Wortlaut. Bei Aenderung Version hochzaehlen — alte Zustimmungen bleiben belegbar. */
export const WITHDRAWAL_WAIVER_VERSION = "2026-09-20";
export const WITHDRAWAL_WAIVER_TEXT =
  "Ich verlange ausdruecklich, dass Sie vor Ablauf der Widerrufsfrist mit der " +
  "Ausfuehrung des Vertrags beginnen. Mir ist bekannt, dass ich mit vollstaendiger " +
  "Vertragserfuellung mein Widerrufsrecht verliere.";

export const consentType = v.union(
  v.literal("withdrawal_waiver"),
  v.literal("terms"),
  v.literal("privacy"),
);

export const recordInternal = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    email: v.optional(v.string()),
    type: consentType,
    bookId: v.optional(v.id("books")),
    planId: v.optional(v.id("subscriptionPlans")),
    stripeSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("consents", {
      userId: args.userId,
      email: args.email,
      type: args.type,
      documentVersion: WITHDRAWAL_WAIVER_VERSION,
      text: WITHDRAWAL_WAIVER_TEXT,
      bookId: args.bookId,
      planId: args.planId,
      stripeSessionId: args.stripeSessionId,
      createdAt: Date.now(),
    });
  },
});

export const myConsents = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("consents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const currentWaiver = query({
  args: {},
  handler: async () => ({
    version: WITHDRAWAL_WAIVER_VERSION,
    text: WITHDRAWAL_WAIVER_TEXT,
  }),
});
