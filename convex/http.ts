import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerRoutes } from "@convex-dev/stripe";
import { auth } from "./auth";
import { checkExtractSecret, checkTileSecret, checkShopSignature } from "./serviceAuth";

const http = httpRouter();

auth.addHttpRoutes(http);

function secs(ts: number | null | undefined): number | undefined {
  return ts == null ? undefined : ts * 1000;
}

// Die Component prueft die Signatur und spiegelt Stripe-Objekte; danach laufen
// diese Handler mit der Fachlogik.
registerRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
  events: {
    // SEPA, Klarna und Sofort melden "completed" auch unbezahlt.
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
        issueId: s.metadata?.issueId || undefined,
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
        issueId: s.metadata?.issueId || undefined,
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
    "invoice.payment_failed": async (ctx, event) => {
      const inv = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.paymentFailed, {
        email: inv.customer_email ?? undefined,
      });
    },
    "customer.subscription.created": subscriptionHandler,
    "customer.subscription.updated": subscriptionHandler,
    "customer.subscription.deleted": async (ctx: any, event: any) => {
      const s = event.data.object as any;
      await ctx.runAction(internal.stripeEvents.subscriptionChanged, {
        stripeSubscriptionId: s.id,
        stripeCustomerId: typeof s.customer === "string" ? s.customer : s.customer?.id,
        stripePriceId: s.items?.data?.[0]?.price?.id,
        status: "canceled",
        startedAt: secs(s.start_date),
        currentPeriodEnd: secs(s.current_period_end),
        endedAt: secs(s.ended_at) ?? Date.now(),
        cancelAtPeriodEnd: true,
        userId: s.metadata?.userId || undefined,
        publicationId: s.metadata?.publicationId || undefined,
      });
    },
  },
});

async function subscriptionHandler(ctx: any, event: any) {
  const s = event.data.object as any;
  await ctx.runAction(internal.stripeEvents.subscriptionChanged, {
    stripeSubscriptionId: s.id,
    stripeCustomerId: typeof s.customer === "string" ? s.customer : s.customer?.id,
    stripePriceId: s.items?.data?.[0]?.price?.id,
    status: s.status,
    startedAt: secs(s.start_date),
    currentPeriodEnd: secs(s.current_period_end),
    cancelAtPeriodEnd: s.cancel_at_period_end ?? false,
    endedAt: secs(s.ended_at),
    userId: s.metadata?.userId || undefined,
    publicationId: s.metadata?.publicationId || undefined,
  });
}

// --- Dienst-Endpunkte ---------------------------------------------------
// Die zugehoerigen Convex-Funktionen sind intern. Das Geheimnis steht im
// Header und wird in konstanter Zeit verglichen; Kachel- und Extraktionsdienst
// haben getrennte Geheimnisse.

async function serviceRoute(
  request: Request,
  allowed: (header: string | null) => boolean,
  run: (body: any) => Promise<unknown>,
): Promise<Response> {
  if (!allowed(request.headers.get("x-service-secret"))) {
    return new Response("forbidden", { status: 403 });
  }
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  try {
    return Response.json((await run(body)) ?? null);
  } catch (err: any) {
    console.error("Dienst-Endpunkt fehlgeschlagen", err?.message ?? err);
    return new Response(
      JSON.stringify({ error: String(err?.message ?? err).slice(0, 300) }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
}

function tileRoute(path: string, run: (ctx: any, body: any) => Promise<unknown>) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      serviceRoute(request, checkTileSecret, (body) => run(ctx, body)),
    ),
  });
}

function workerRoute(path: string, run: (ctx: any, body: any) => Promise<unknown>) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      serviceRoute(request, checkExtractSecret, (body) => run(ctx, body)),
    ),
  });
}

tileRoute("/service/session/verify", (ctx, body) =>
  ctx.runQuery(internal.readerSessions.verifyInternal, {
    sessionToken: String(body.sessionToken ?? ""),
  }),
);

tileRoute("/service/session/usage", (ctx, body) =>
  ctx.runMutation(internal.readerSessions.reportUsageInternal, {
    sessionToken: String(body.sessionToken ?? ""),
    tiles: Number(body.tiles ?? 0),
  }),
);

tileRoute("/service/page/resolve", (ctx, body) =>
  ctx.runQuery(internal.issuePages.resolveForServiceInternal, {
    issueId: body.issueId,
    index: Number(body.index ?? 0),
  }),
);

workerRoute("/service/jobs/claim", (ctx, body) =>
  ctx.runMutation(internal.imports.claimNextInternal, {
    workerId: String(body.workerId ?? "worker"),
  }),
);

workerRoute("/service/jobs/heartbeat", (ctx, body) =>
  ctx.runMutation(internal.imports.heartbeatInternal, {
    jobId: body.jobId,
    workerId: String(body.workerId ?? ""),
    progress: body.progress,
    message: body.message,
  }),
);

workerRoute("/service/jobs/finish", (ctx, body) =>
  ctx.runMutation(internal.imports.finishInternal, {
    jobId: body.jobId,
    workerId: String(body.workerId ?? ""),
    status: body.status,
    message: body.message,
  }),
);

workerRoute("/service/jobs/result", (ctx, body) =>
  ctx.runMutation(internal.imports.activateResultInternal, {
    jobId: body.jobId,
    workerId: String(body.workerId ?? ""),
    issueId: body.issueId,
    articles: body.articles ?? [],
    tocEntries: body.tocEntries,
  }),
);

workerRoute("/service/storage/upload-url", async (ctx) => ({
  uploadUrl: await ctx.runMutation(internal.assets.generateUploadUrlInternal, {}),
}));

workerRoute("/service/assets/register", (ctx, body) =>
  ctx.runMutation(internal.assets.createInternal, {
    key: String(body.key),
    contentType: String(body.contentType ?? "application/octet-stream"),
    kind: body.kind,
    issueId: body.issueId,
    convexStorageId: body.storageId,
    bytes: body.bytes,
    width: body.width,
    height: body.height,
    bucket: body.bucket,
  }),
);

workerRoute("/service/pages/rendered", (ctx, body) =>
  ctx.runMutation(internal.issuePages.setRenderedInternal, {
    issueId: body.issueId,
    index: Number(body.index),
    width: Number(body.width),
    height: Number(body.height),
    tileManifestKey: body.tileManifestKey,
    previewKey: body.previewKey,
  }),
);

workerRoute("/service/issue/counts", (ctx, body) =>
  ctx.runMutation(internal.issues.setCountsInternal, {
    issueId: body.issueId,
    pageCount: body.pageCount,
    articleCount: body.articleCount,
    coverAssetId: body.coverAssetId,
  }),
);

// --- Shop-Schnittstelle -------------------------------------------------

http.route({
  path: "/shop/entitlements",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    const signature = request.headers.get("x-shop-signature");
    if (!(await checkShopSignature(raw, signature))) {
      return new Response(JSON.stringify({ ok: false, error: "bad_signature" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "bad_json" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    for (const field of ["externalOrderId", "email", "action"]) {
      if (!body[field]) {
        return Response.json(
          { ok: false, error: "missing_field", field },
          { status: 400 },
        );
      }
    }
    if (!body.issueSku && !body.issueId) {
      return Response.json(
        { ok: false, error: "missing_field", field: "issueSku" },
        { status: 400 },
      );
    }
    const result: any = await ctx.runMutation(internal.shopIntegration.applyInternal, {
      externalOrderId: String(body.externalOrderId),
      externalCustomerId: body.externalCustomerId,
      email: String(body.email),
      issueSku: body.issueSku,
      issueId: body.issueId,
      action: body.action === "revoke" ? "revoke" : "grant",
    });
    return Response.json(result, { status: result.ok ? 200 : 404 });
  }),
});

export default http;
