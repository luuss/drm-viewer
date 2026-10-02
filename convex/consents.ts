import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

/** Aktueller Wortlaut. Bei Aenderung Version hochzaehlen — alte Zustimmungen bleiben belegbar. */
// Wortlaut fuer digitale Inhalte (§ 356 Abs. 5 BGB): das Recht erlischt mit
// Beginn der Ausfuehrung, nicht erst mit vollstaendiger Erfuellung.
export const WITHDRAWAL_WAIVER_VERSION = "2026-10-02";
export const WITHDRAWAL_WAIVER_TEXT =
  "Ich stimme ausdrücklich zu, dass Sie vor Ablauf der Widerrufsfrist mit der " +
  "Ausführung des Vertrags beginnen. Mir ist bekannt, dass ich durch diese " +
  "Zustimmung mit Beginn der Ausführung des Vertrags mein Widerrufsrecht verliere.";

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
    issueId: v.optional(v.id("issues")),
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
      issueId: args.issueId,
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
