"use node";

import { v } from "convex/values";
import Stripe from "stripe";
import { StripeSubscriptions } from "@convex-dev/stripe";
import { action } from "./_generated/server";
import { api, components, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

const stripeClient = new StripeSubscriptions(components.stripe);

function rawStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

async function requireUser(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Nicht eingeloggt");
  const me: any = await ctx.runQuery(api.users.me, {});
  return { userId: userId as Id<"users">, email: me?.email as string | undefined };
}

/**
 * Legt (einmalig) Produkt + Preis in Stripe fuer ein Heft an und merkt sich die IDs.
 * Einzelkauf laeuft ueber echte Stripe-Preise statt price_data — noetig fuer die
 * Component und sauberer fuer Buchhaltung/Steuer.
 */
export const ensureBookPrice = action({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }): Promise<{ priceId: string }> => {
    await ctx.runQuery(api.users.requireAdminQuery, {});
    const book: any = await ctx.runQuery(internal.books.getBookInternal, { bookId });
    if (!book) throw new Error("Heft nicht gefunden");
    if (book.stripePriceId) return { priceId: book.stripePriceId };

    const stripe = rawStripe();
    const product = await stripe.products.create(
      {
        name: book.title,
        description: book.description || undefined,
        metadata: { bookId: bookId as string },
      },
      { idempotencyKey: `product-${bookId}` },
    );
    const price = await stripe.prices.create(
      {
        product: product.id,
        unit_amount: book.priceCents,
        currency: book.currency,
        tax_behavior: "inclusive",
      },
      { idempotencyKey: `price-${bookId}-${book.priceCents}` },
    );

    await ctx.runMutation(internal.books.setStripeIdsInternal, {
      bookId,
      stripeProductId: product.id,
      stripePriceId: price.id,
    });
    return { priceId: price.id };
  },
});

/** Abo-Plan in Stripe anlegen (Produkt + wiederkehrender Preis) und in Convex speichern. */
export const createPlanWithPrice = action({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    priceCents: v.number(),
    interval: v.union(v.literal("month"), v.literal("year")),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ planId: Id<"subscriptionPlans">; priceId: string }> => {
    await ctx.runQuery(api.users.requireAdminQuery, {});
    const stripe = rawStripe();
    const currency = args.currency ?? "eur";
    const product = await stripe.products.create({
      name: args.name,
      description: args.description || undefined,
      metadata: { kind: "subscription" },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: args.priceCents,
      currency,
      recurring: { interval: args.interval },
      tax_behavior: "inclusive",
    });
    const planId: Id<"subscriptionPlans"> = await ctx.runMutation(api.plans.create, {
      name: args.name,
      description: args.description,
      stripePriceId: price.id,
      priceCents: args.priceCents,
      currency,
      interval: args.interval,
    });
    return { planId, priceId: price.id };
  },
});

export const createBookCheckout = action({
  args: {
    bookId: v.id("books"),
    successUrl: v.string(),
    cancelUrl: v.string(),
    withdrawalWaiver: v.boolean(),
  },
  handler: async (
    ctx,
    { bookId, successUrl, cancelUrl, withdrawalWaiver },
  ): Promise<{ url: string }> => {
    if (!withdrawalWaiver) {
      throw new Error(
        "Ohne Zustimmung zum sofortigen Zugriff (Widerrufsverzicht) ist kein Kauf moeglich.",
      );
    }
    const { userId, email } = await requireUser(ctx);
    const book: any = await ctx.runQuery(api.books.getBook, { bookId });
    if (!book) throw new Error("Heft nicht gefunden");

    const { priceId } = await ctx.runAction(api.billing.ensureBookPrice, { bookId });

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
      metadata: { bookId: bookId as string, userId: userId as string },
      paymentIntentMetadata: { bookId: bookId as string, userId: userId as string },
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
      bookId,
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
        "Ohne Zustimmung zum sofortigen Zugriff (Widerrufsverzicht) ist kein Abo moeglich.",
      );
    }
    const { userId, email } = await requireUser(ctx);
    const plan: any = await ctx.runQuery(api.plans.get, { planId });
    if (!plan || !plan.isActive) throw new Error("Abo nicht verfuegbar");

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
      subscriptionMetadata: { planId: planId as string, userId: userId as string },
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

/** Kundenportal: Kuendigung, Zahlungsmittel, Rechnungen — ohne eigenen Support-Aufwand. */
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
    const owned: boolean = await ctx.runQuery(internal.subscriptions.isOwnedBy, {
      userId,
      stripeSubscriptionId,
    });
    if (!owned) throw new Error("Abo gehoert nicht zu diesem Account");
    await stripeClient.cancelSubscription(ctx, {
      stripeSubscriptionId,
      cancelAtPeriodEnd: !immediately,
    });
    return null;
  },
});
