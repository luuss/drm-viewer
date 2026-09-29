import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Einloeselinks fuer Gastkaeufe ueber Stripe. Seit der Anmeldung per
 * E-Mail-Link gibt es keinen eigenen Einloeseschritt mehr: wer sich mit der
 * Kaufadresse anmeldet, bekommt offene Links automatisch
 * (`magicLink.consumeInternal`). Alte Links `/claim/<token>` fuehren auf die
 * Anmeldung.
 */

const TOKEN_TTL_DAYS = 30;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const createInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    email: v.string(),
    stripeSessionId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Stripe wiederholt Ereignisse; ohne diese Pruefung entstuende je
    // Wiederholung ein weiterer einloesbarer Zugang.
    if (args.stripeSessionId) {
      const existing = await ctx.db
        .query("claimTokens")
        .withIndex("by_stripe_session", (q) =>
          q.eq("stripeSessionId", args.stripeSessionId),
        )
        .first();
      if (existing) return existing.token;
    }
    const token = randomToken();
    const now = Date.now();
    await ctx.db.insert("claimTokens", {
      token,
      issueId: args.issueId,
      email: args.email.toLowerCase(),
      stripeSessionId: args.stripeSessionId,
      externalOrderId: args.externalOrderId,
      expiresAt: now + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      createdAt: now,
    });
    return token;
  },
});
