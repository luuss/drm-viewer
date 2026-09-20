import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

function log(event: string, detail: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...detail }));
}

/** Einzelkauf abgeschlossen und bezahlt. */
export const checkoutCompleted = internalAction({
  args: {
    sessionId: v.string(),
    mode: v.string(),
    email: v.string(),
    amountCents: v.number(),
    issueId: v.optional(v.string()),
    planId: v.optional(v.string()),
    userId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.userId ? (args.userId as Id<"users">) : undefined;

    if (args.mode === "payment") {
      if (!args.issueId) return { ok: false, reason: "issueId fehlt" };
      const issueId = args.issueId as Id<"issues">;

      await ctx.runMutation(internal.purchases.recordPaid, {
        userId,
        email: args.email,
        issueId,
        stripeSessionId: args.sessionId,
        stripePaymentIntentId: args.paymentIntentId,
        amountCents: args.amountCents,
      });

      if (userId) {
        await ctx.runMutation(internal.entitlements.grantInternal, {
          userId,
          issueId,
          source: "purchase",
          stripeSessionId: args.sessionId,
        });
      } else if (args.email) {
        // Gastkauf: Zugang per Einloeselink, gebunden an die Kauf-Mailadresse.
        const token: string = await ctx.runMutation(internal.claims.createInternal, {
          issueId,
          email: args.email,
          stripeSessionId: args.sessionId,
        });
        try {
          await ctx.runAction(internal.email.sendClaimEmail, {
            email: args.email,
            issueId,
            token,
          });
        } catch (err) {
          console.error("Claim-Mail fehlgeschlagen", err);
        }
      }
      log("stripe.checkout.paid", { mode: "payment", issueId });
      return { ok: true };
    }

    if (args.mode === "subscription") {
      await ctx.runMutation(internal.purchases.recordPaid, {
        userId,
        email: args.email,
        planId: args.planId ? (args.planId as Id<"subscriptionPlans">) : undefined,
        stripeSessionId: args.sessionId,
        amountCents: args.amountCents,
      });
      if (args.email) {
        try {
          await ctx.runAction(internal.email.sendSubscriptionStarted, {
            email: args.email,
          });
        } catch (err) {
          console.error("Abo-Mail fehlgeschlagen", err);
        }
      }
      log("stripe.checkout.paid", { mode: "subscription" });
      return { ok: true };
    }
    return { ok: true };
  },
});

/**
 * Abo-Zustand spiegeln. Die Freischaltung einzelner Ausgaben passiert in
 * `subscriptions.upsertFromStripe`, damit sie idempotent bleibt.
 */
export const subscriptionChanged = internalAction({
  args: {
    stripeSubscriptionId: v.string(),
    stripeCustomerId: v.string(),
    stripePriceId: v.optional(v.string()),
    status: v.string(),
    startedAt: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    endedAt: v.optional(v.number()),
    userId: v.optional(v.string()),
    publicationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let userId = args.userId;
    if (!userId) {
      const found: string | null = await ctx.runQuery(
        internal.subscriptions.findUserByCustomerInternal,
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
      startedAt: args.startedAt,
      currentPeriodEnd: args.currentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      endedAt: args.endedAt,
      publicationId: args.publicationId
        ? (args.publicationId as Id<"publications">)
        : undefined,
    });
    log("stripe.subscription", {
      status: args.status,
      subscription: args.stripeSubscriptionId,
    });
    return { ok: true };
  },
});

/** Rueckerstattung oder Chargeback: Kaufzugriff entziehen. */
export const paymentReversed = internalAction({
  args: { stripePaymentIntentId: v.string(), reason: v.string() },
  handler: async (ctx, { stripePaymentIntentId, reason }) => {
    const purchaseId = await ctx.runMutation(internal.purchases.markRefunded, {
      stripePaymentIntentId,
    });
    log("stripe.reversed", { reason, revoked: Boolean(purchaseId) });
    return { ok: true };
  },
});

export const paymentFailed = internalAction({
  args: { email: v.optional(v.string()) },
  handler: async (ctx, { email }) => {
    if (!email) return { ok: false };
    await ctx.runAction(internal.email.sendPaymentFailed, { email });
    log("stripe.paymentFailed", {});
    return { ok: true };
  },
});
