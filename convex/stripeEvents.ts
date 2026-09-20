import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * Einmalkauf abgeschlossen: Kauf protokollieren, Heft freischalten,
 * Claim-Link mailen (fuer Kaeufe ohne eingeloggten Account).
 */
export const checkoutCompleted = internalAction({
  args: {
    sessionId: v.string(),
    mode: v.string(),
    email: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    bookId: v.optional(v.string()),
    planId: v.optional(v.string()),
    userId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.userId ? (args.userId as Id<"users">) : undefined;

    if (args.mode === "payment") {
      if (!args.bookId) return { ok: false, reason: "missing bookId" };
      const bookId = args.bookId as Id<"books">;

      await ctx.runMutation(internal.purchases.recordPaid, {
        userId,
        email: args.email,
        bookId,
        stripeSessionId: args.sessionId,
        stripePaymentIntentId: args.paymentIntentId,
        amountCents: args.amountCents,
        currency: args.currency,
      });

      if (userId) {
        await ctx.runMutation(internal.books.grantEntitlementInternal, {
          userId,
          bookId,
          source: "purchase",
          stripeSessionId: args.sessionId,
        });
      }

      const token: string = await ctx.runMutation(
        internal.claims.createClaimTokenInternal,
        { bookId, email: args.email, stripeSessionId: args.sessionId },
      );
      if (args.email) {
        await ctx.runAction(internal.email.sendClaimEmail, {
          email: args.email,
          bookId,
          token,
        });
      }
      return { ok: true };
    }

    if (args.mode === "subscription") {
      await ctx.runMutation(internal.purchases.recordPaid, {
        userId,
        email: args.email,
        planId: args.planId ? (args.planId as Id<"subscriptionPlans">) : undefined,
        stripeSessionId: args.sessionId,
        amountCents: args.amountCents,
        currency: args.currency,
      });
      if (args.email) {
        await ctx.runAction(internal.email.sendSubscriptionStarted, {
          email: args.email,
        });
      }
      return { ok: true };
    }

    return { ok: true };
  },
});

/** Abo-Status aus Stripe spiegeln (aktiv, gekuendigt, Zahlung offen). */
export const subscriptionChanged = internalAction({
  args: {
    stripeSubscriptionId: v.string(),
    stripeCustomerId: v.string(),
    stripePriceId: v.optional(v.string()),
    status: v.string(),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    userId: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let userId = args.userId;
    if (!userId) {
      const found: string | null = await ctx.runQuery(
        internal.subscriptions.findUserByCustomer,
        { stripeCustomerId: args.stripeCustomerId },
      );
      userId = found ?? undefined;
    }
    await ctx.runMutation(internal.subscriptions.upsertFromStripe, {
      userId,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId,
      status: args.status,
      currentPeriodEnd: args.currentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
    });
    return { ok: true };
  },
});

/** Zahlung geplatzt: Kunde informieren, Zugriff laeuft nach Kulanzfrist aus. */
export const paymentFailed = internalAction({
  args: { email: v.optional(v.string()), amountCents: v.optional(v.number()) },
  handler: async (ctx, { email }) => {
    if (!email) return { ok: false };
    await ctx.runAction(internal.email.sendPaymentFailed, { email });
    return { ok: true };
  },
});
