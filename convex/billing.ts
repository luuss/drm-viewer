"use node";

import { v } from "convex/values";
import Stripe from "stripe";
import { StripeSubscriptions } from "@convex-dev/stripe";
import { action } from "./_generated/server";
import { api, components, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

const stripeClient = new StripeSubscriptions(components.stripe);

/** Das MVP fuehrt ausschliesslich Euro. */
const CURRENCY = "eur";

function rawStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY nicht gesetzt");
  return new Stripe(key);
}

async function requireUser(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Nicht angemeldet");
  const me: any = await ctx.runQuery(api.users.me, {});
  return { userId: userId as Id<"users">, email: me?.email as string | undefined };
}

async function requireRole(ctx: any, role: string) {
  await ctx.runQuery(api.users.requireRoleQuery, { role });
}

/**
 * Legt Produkt und Preis in Stripe an. Der verbindliche Preis steht lokal an
 * der Ausgabe; Stripe bekommt nur eine Zuordnung.
 */
export const ensureIssuePrice = action({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }): Promise<{ priceId: string }> => {
    await requireRole(ctx, "publisher");
    const issue: any = await ctx.runQuery(internal.issues.getInternal, { issueId });
    if (!issue) throw new Error("Ausgabe nicht gefunden");
    if (issue.stripePriceId) return { priceId: issue.stripePriceId };

    const stripe = rawStripe();
    const product = await stripe.products.create(
      {
        name: issue.title,
        description: issue.description || undefined,
        metadata: { issueId: issueId as string },
      },
      { idempotencyKey: `product-${issueId}` },
    );
    const price = await stripe.prices.create(
      {
        product: product.id,
        unit_amount: issue.priceAmountCents,
        currency: CURRENCY,
        tax_behavior: "inclusive",
      },
      { idempotencyKey: `price-${issueId}-${issue.priceAmountCents}` },
    );
    await ctx.runMutation(internal.issues.setStripeIdsInternal, {
      issueId,
      stripeProductId: product.id,
      stripePriceId: price.id,
    });
    return { priceId: price.id };
  },
});

export const createPlanWithPrice = action({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    publicationId: v.id("publications"),
    priceAmountCents: v.number(),
    interval: v.union(v.literal("month"), v.literal("year")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ planId: Id<"subscriptionPlans">; priceId: string }> => {
    await requireRole(ctx, "admin");
    const stripe = rawStripe();
    const product = await stripe.products.create({
      name: args.name,
      description: args.description || undefined,
      metadata: { kind: "subscription", publicationId: args.publicationId as string },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: args.priceAmountCents,
      currency: CURRENCY,
      recurring: { interval: args.interval },
      tax_behavior: "inclusive",
    });
    const planId: Id<"subscriptionPlans"> = await ctx.runMutation(api.plans.create, {
      name: args.name,
      description: args.description,
      publicationId: args.publicationId,
      stripePriceId: price.id,
      priceAmountCents: args.priceAmountCents,
      interval: args.interval,
    });
    return { planId, priceId: price.id };
  },
});

export const createIssueCheckout = action({
  args: {
    issueId: v.id("issues"),
    successUrl: v.string(),
    cancelUrl: v.string(),
    withdrawalWaiver: v.boolean(),
  },
  handler: async (
    ctx,
    { issueId, successUrl, cancelUrl, withdrawalWaiver },
  ): Promise<{ url: string }> => {
    if (!withdrawalWaiver) {
      throw new Error(
        "Ohne Zustimmung zum sofortigen Zugriff (Widerrufsverzicht) ist kein Kauf möglich.",
      );
    }
    const { userId, email } = await requireUser(ctx);
    const issue: any = await ctx.runQuery(api.issues.getPublic, { issueId });
    if (!issue) throw new Error("Ausgabe nicht verfügbar");

    const { priceId } = await ctx.runAction(api.billing.ensureIssuePrice, { issueId });
    const customer = await stripeClient.getOrCreateCustomer(ctx, {
      userId: userId as string,
      email,
    });
    const session = await stripeClient.createCheckoutSession(ctx, {
      priceId,
      customerId: customer.customerId,
      mode: "payment",
      successUrl,
      cancelUrl,
      metadata: { issueId: issueId as string, userId: userId as string },
      paymentIntentMetadata: { issueId: issueId as string, userId: userId as string },
      params: {
        locale: "de",
        invoice_creation: { enabled: true },
        automatic_tax: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
      },
    });
    await ctx.runMutation(internal.consents.recordInternal, {
      userId,
      email,
      type: "withdrawal_waiver",
      issueId,
      stripeSessionId: session.sessionId,
    });
    if (!session.url) throw new Error("Stripe lieferte keine Checkout-URL");
    return { url: session.url };
  },
});

export const createSubscriptionCheckout = action({
  args: {
    planId: v.id("subscriptionPlans"),
    successUrl: v.string(),
    cancelUrl: v.string(),
    withdrawalWaiver: v.boolean(),
  },
  handler: async (
    ctx,
    { planId, successUrl, cancelUrl, withdrawalWaiver },
  ): Promise<{ url: string }> => {
    if (!withdrawalWaiver) {
      throw new Error(
        "Ohne Zustimmung zum sofortigen Zugriff (Widerrufsverzicht) ist kein Abo möglich.",
      );
    }
    const { userId, email } = await requireUser(ctx);
    const plan: any = await ctx.runQuery(api.plans.get, { planId });
    if (!plan || !plan.isActive) throw new Error("Abo nicht verfügbar");

    const customer = await stripeClient.getOrCreateCustomer(ctx, {
      userId: userId as string,
      email,
    });
    const session = await stripeClient.createCheckoutSession(ctx, {
      priceId: plan.stripePriceId,
      customerId: customer.customerId,
      mode: "subscription",
      successUrl,
      cancelUrl,
      metadata: { planId: planId as string, userId: userId as string },
      subscriptionMetadata: {
        planId: planId as string,
        userId: userId as string,
        publicationId: plan.publicationId as string,
      },
      params: {
        locale: "de",
        automatic_tax: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
      },
    });
    await ctx.runMutation(internal.consents.recordInternal, {
      userId,
      email,
      type: "withdrawal_waiver",
      planId,
      stripeSessionId: session.sessionId,
    });
    if (!session.url) throw new Error("Stripe lieferte keine Checkout-URL");
    return { url: session.url };
  },
});

/** Kundenportal: Kuendigung, Zahlungsmittel, Rechnungen ohne Support-Aufwand. */
export const createPortalSession = action({
  args: { returnUrl: v.string() },
  handler: async (ctx, { returnUrl }): Promise<{ url: string }> => {
    const { userId, email } = await requireUser(ctx);
    const customer = await stripeClient.getOrCreateCustomer(ctx, {
      userId: userId as string,
      email,
    });
    const session = await stripeClient.createCustomerPortalSession(ctx, {
      customerId: customer.customerId,
      returnUrl,
    });
    return { url: session.url };
  },
});

export const cancelMySubscription = action({
  args: { stripeSubscriptionId: v.string(), immediately: v.optional(v.boolean()) },
  handler: async (ctx, { stripeSubscriptionId, immediately }): Promise<null> => {
    const { userId } = await requireUser(ctx);
    const owned: boolean = await ctx.runQuery(
      internal.subscriptions.isOwnedByInternal,
      { userId, stripeSubscriptionId },
    );
    if (!owned) throw new Error("Abo gehört nicht zu diesem Konto");
    await stripeClient.cancelSubscription(ctx, {
      stripeSubscriptionId,
      cancelAtPeriodEnd: !immediately,
    });
    return null;
  },
});
