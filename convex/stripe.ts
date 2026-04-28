"use node";

import { v } from "convex/values";
import Stripe from "stripe";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key, { apiVersion: "2024-12-18.acacia" });
}

export const createCheckoutSession = action({
  args: {
    bookId: v.id("books"),
    successUrl: v.string(),
    cancelUrl: v.string(),
  },
  handler: async (ctx, { bookId, successUrl, cancelUrl }): Promise<{ url: string }> => {
    const userId = await getAuthUserId(ctx);
    const book = await ctx.runQuery(api.books.getBook, { bookId });
    if (!book) throw new Error("Buch nicht gefunden");

    let email: string | undefined;
    if (userId) {
      const user: any = await ctx.runQuery(api.users.me, {});
      email = user?.email;
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: book.currency,
            unit_amount: book.priceCents,
            product_data: { name: book.title },
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookId: bookId as string,
        userId: (userId as string | null) ?? "",
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { url: session.url! };
  },
});

export const handleWebhookInternal = internalAction({
  args: { payload: v.string(), signature: v.string() },
  handler: async (ctx, { payload, signature }) => {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (err: any) {
      throw new Error(`Webhook signature invalid: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookId = session.metadata?.bookId as Id<"books"> | undefined;
      const userIdMeta = session.metadata?.userId || undefined;
      const email =
        session.customer_details?.email || session.customer_email || "";

      if (!bookId) return { ok: false, reason: "missing bookId" };

      await ctx.runMutation(internal.purchases.recordPaid, {
        userId: userIdMeta ? (userIdMeta as Id<"users">) : undefined,
        email,
        bookId,
        stripeSessionId: session.id,
        stripePaymentIntentId: (session.payment_intent as string) || undefined,
        amountCents: session.amount_total ?? 0,
        currency: session.currency ?? "eur",
      });

      if (userIdMeta) {
        await ctx.runMutation(internal.books.grantEntitlementInternal, {
          userId: userIdMeta as Id<"users">,
          bookId,
          source: "purchase",
          stripeSessionId: session.id,
        });
      }

      const token: string = await ctx.runMutation(
        internal.claims.createClaimTokenInternal,
        { bookId, email, stripeSessionId: session.id },
      );

      if (email) {
        await ctx.runAction(internal.email.sendClaimEmail, {
          email,
          bookId,
          token,
        });
      }
    }
    return { ok: true };
  },
});
