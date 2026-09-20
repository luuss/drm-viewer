import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerRoutes } from "@convex-dev/stripe";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

function secs(ts: number | null | undefined): number | undefined {
  return ts == null ? undefined : ts * 1000;
}

// Die Component verifiziert die Signatur und spiegelt Stripe-Objekte selbst.
// Danach laufen diese Handler mit der Fachlogik (Freischaltung, Mails).
registerRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
  events: {
    "checkout.session.completed": async (ctx, event) => {
      const s = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.checkoutCompleted, {
        sessionId: s.id,
        mode: s.mode ?? "payment",
        email: s.customer_details?.email ?? s.customer_email ?? "",
        amountCents: s.amount_total ?? 0,
        currency: s.currency ?? "eur",
        bookId: s.metadata?.bookId || undefined,
        planId: s.metadata?.planId || undefined,
        userId: s.metadata?.userId || undefined,
        paymentIntentId:
          typeof s.payment_intent === "string" ? s.payment_intent : undefined,
      });
    },
    "customer.subscription.created": async (ctx, event) => {
      const s = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.subscriptionChanged, {
        stripeSubscriptionId: s.id,
        stripeCustomerId:
          typeof s.customer === "string" ? s.customer : s.customer?.id,
        stripePriceId: s.items?.data?.[0]?.price?.id,
        status: s.status,
        currentPeriodEnd: secs(s.current_period_end),
        cancelAtPeriodEnd: s.cancel_at_period_end ?? false,
        userId: s.metadata?.userId || undefined,
      });
    },
    "customer.subscription.updated": async (ctx, event) => {
      const s = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.subscriptionChanged, {
        stripeSubscriptionId: s.id,
        stripeCustomerId:
          typeof s.customer === "string" ? s.customer : s.customer?.id,
        stripePriceId: s.items?.data?.[0]?.price?.id,
        status: s.status,
        currentPeriodEnd: secs(s.current_period_end),
        cancelAtPeriodEnd: s.cancel_at_period_end ?? false,
        userId: s.metadata?.userId || undefined,
      });
    },
    "customer.subscription.deleted": async (ctx, event) => {
      const s = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.subscriptionChanged, {
        stripeSubscriptionId: s.id,
        stripeCustomerId:
          typeof s.customer === "string" ? s.customer : s.customer?.id,
        stripePriceId: s.items?.data?.[0]?.price?.id,
        status: "canceled",
        currentPeriodEnd: secs(s.current_period_end),
        cancelAtPeriodEnd: true,
        userId: s.metadata?.userId || undefined,
      });
    },
    "invoice.payment_failed": async (ctx, event) => {
      const inv = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.paymentFailed, {
        email: inv.customer_email ?? undefined,
        amountCents: inv.amount_due ?? undefined,
      });
    },
  },
});

/**
 * Rueckkanal des Extraktions-Dienstes (IDML/PDF -> Artikel).
 * Authentifiziert ueber das gemeinsame Service-Geheimnis, nicht ueber Nutzer-Login.
 */
http.route({
  path: "/import/result",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = request.headers.get("x-service-secret");
    if (!secret || secret !== process.env.TILE_SERVICE_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    try {
      const result = await ctx.runMutation(internal.imports.applyResult, {
        jobId: body.jobId,
        bookId: body.bookId,
        status: body.status,
        message: body.message,
        progress: body.progress,
        articles: body.articles,
        replace: body.replace ?? false,
      });
      return Response.json(result);
    } catch (err: any) {
      return new Response(err?.message ?? "error", { status: 400 });
    }
  }),
});

export default http;
