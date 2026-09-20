import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerRoutes } from "@convex-dev/stripe";
import { auth } from "./auth";
import { checkExtractSecret, checkTileSecret } from "./serviceAuth";

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
    // SEPA, Klarna und Sofort melden "completed" bereits als unbezahlt.
    // Freischalten erst, wenn das Geld da ist.
    "checkout.session.completed": async (ctx, event) => {
      const s = event.data.object as any;
      if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
        return;
      }
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
    "checkout.session.async_payment_succeeded": async (ctx, event) => {
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
    "checkout.session.async_payment_failed": async (ctx, event) => {
      const s = event.data.object as any;
      if (typeof s.payment_intent === "string") {
        await ctx.runAction(internal.stripeEvents.paymentReversed, {
          stripePaymentIntentId: s.payment_intent,
          reason: "async_payment_failed",
        });
      }
    },
    "charge.refunded": async (ctx, event) => {
      const c = event.data.object as any;
      if (typeof c.payment_intent === "string") {
        await ctx.runAction(internal.stripeEvents.paymentReversed, {
          stripePaymentIntentId: c.payment_intent,
          reason: "refund",
        });
      }
    },
    "charge.dispute.created": async (ctx, event) => {
      const d = event.data.object as any;
      if (typeof d.payment_intent === "string") {
        await ctx.runAction(internal.stripeEvents.paymentReversed, {
          stripePaymentIntentId: d.payment_intent,
          reason: "dispute",
        });
      }
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
    if (!checkExtractSecret(request.headers.get("x-service-secret"))) {
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

/**
 * Endpunkte fuer den Kacheldienst. Vorher lagen diese Funktionen als
 * oeffentliche Queries offen und wurden nur ueber ein Argument geschuetzt —
 * damit war die signierte URL zum Original-PDF einen Request weit entfernt,
 * sobald das Geheimnis irgendwo auftauchte.
 */
async function tileServiceRoute(
  ctx: any,
  request: Request,
  run: (body: any) => Promise<unknown>,
): Promise<Response> {
  if (!checkTileSecret(request.headers.get("x-service-secret"))) {
    return new Response("forbidden", { status: 403 });
  }
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  try {
    return Response.json(await run(body));
  } catch (err: any) {
    console.error("Dienst-Endpunkt fehlgeschlagen", err);
    return new Response("error", { status: 400 });
  }
}

http.route({
  path: "/service/session/verify",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    tileServiceRoute(ctx, request, async (body) => {
      const result = await ctx.runQuery(internal.tileSessions.verify, {
        sessionToken: String(body.sessionToken ?? ""),
      });
      return result;
    }),
  ),
});

http.route({
  path: "/service/session/usage",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    tileServiceRoute(ctx, request, async (body) =>
      ctx.runMutation(internal.tileSessions.reportUsage, {
        sessionToken: String(body.sessionToken ?? ""),
        tiles: Number(body.tiles ?? 0),
      }),
    ),
  ),
});

http.route({
  path: "/service/book/pdf-url",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    tileServiceRoute(ctx, request, async (body) =>
      ctx.runQuery(internal.books.getStoragePdfUrlForService, {
        bookId: body.bookId,
      }),
    ),
  ),
});

/** Nur der Extraktionsdienst braucht die Satzdatei — eigenes Geheimnis. */
http.route({
  path: "/service/book/source-url",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkExtractSecret(request.headers.get("x-service-secret"))) {
      return new Response("forbidden", { status: 403 });
    }
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    try {
      const result = await ctx.runQuery(
        internal.books.getSourceUrlForService,
        { bookId: body.bookId, which: body.which === "source" ? "source" : "pdf" },
      );
      return Response.json(result);
    } catch (err: any) {
      console.error("Quell-URL fehlgeschlagen", err);
      return new Response("error", { status: 400 });
    }
  }),
});

export default http;
