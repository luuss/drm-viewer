import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { signaturBilden } from "./leserStripe";
import { ABO_HERKUNFT, aboAusStripe } from "./leserAbo";

const modules = import.meta.glob("./**/*.ts");

const WH_LIVE = "whsec_live_geheimnis";

function kasseLive() {
  process.env.LESER_STRIPE_MODE = "live";
  process.env.LESER_STRIPE_SECRET_KEY_LIVE = "sk_live_x";
  process.env.LESER_STRIPE_PUBLISHABLE_KEY_LIVE = "pk_live_x";
  process.env.LESER_STRIPE_WEBHOOK_SECRET_LIVE = WH_LIVE;
}

async function aufbau(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: "leser@example.de" });
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: now,
    });
    const heft = await ctx.db.insert("issues", {
      publicationId,
      title: "ZUERST! 3/2026",
      slug: "zuerst-3-2026",
      pageCount: 4,
      priceAmountCents: 690,
      isPublished: true,
      publishedAt: now - 1000,
      includedInSubscription: true,
      createdAt: now - 1000,
      updatedAt: now,
    });
    return {
      userId: userId as Id<"users">,
      publicationId: publicationId as Id<"publications">,
      heft: heft as Id<"issues">,
    };
  });
}

async function senden(t: any, event: any) {
  const rumpf = JSON.stringify(event);
  const sig = await signaturBilden(rumpf, WH_LIVE, Math.floor(Date.now() / 1000));
  return await t.fetch("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body: rumpf,
  });
}

function abo(s: { userId: string; publicationId: string }, extra: Record<string, unknown> = {}) {
  const jetzt = Math.floor(Date.now() / 1000);
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    start_date: jetzt - 60,
    cancel_at_period_end: false,
    // Neuere API-Versionen fuehren das Laufzeitende am Posten.
    items: { data: [{ price: { id: "price_1" }, current_period_end: jetzt + 365 * 86400 }] },
    metadata: { source: ABO_HERKUNFT, userId: s.userId, publicationId: s.publicationId },
    ...extra,
  };
}

describe("leserAbo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    kasseLive();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const k of [
      "LESER_STRIPE_MODE",
      "LESER_STRIPE_SECRET_KEY_LIVE",
      "LESER_STRIPE_PUBLISHABLE_KEY_LIVE",
      "LESER_STRIPE_WEBHOOK_SECRET_LIVE",
    ]) {
      delete process.env[k];
    }
  });

  test("aboAusStripe liest das Laufzeitende auch vom Posten", () => {
    const a = aboAusStripe(abo({ userId: "u", publicationId: "p" }), "live");
    expect(a).toMatchObject({ stripeSubscriptionId: "sub_1", stripePriceId: "price_1", status: "active" });
    expect(a.currentPeriodEnd).toBeGreaterThan(Date.now());
    expect(aboAusStripe(abo({ userId: "u", publicationId: "p" }), "live", true)).toMatchObject({
      status: "canceled",
      cancelAtPeriodEnd: true,
    });
  });

  test("ein neuer Preis loest den alten seiner Stufe ab; im Angebot nur im Modus der Kasse", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const setzen = (
      cents: number,
      modus: "test" | "live",
      tier = "Normalabonnement",
      region: "inland" | "ausland" | null = "inland",
      sortOrder = 0,
    ) =>
      t.mutation(internal.leserAbo.planSetzen, {
        publicationId: s.publicationId,
        modus,
        tier,
        region: region ?? undefined,
        name: `${tier} ${region ?? ""}`.trim(),
        sortOrder,
        priceAmountCents: cents,
        stripePriceId: `price_${cents}_${modus}`,
        stripeProductId: "prod_1",
        stripeTaxRateId: "txr_1",
      });
    // Der fruehere Einzelpreis ohne Gebiet geht mit der ersten Katalogstufe.
    await setzen(4900, "live", "Jahresabo", null);
    await setzen(10440, "live");
    await setzen(10900, "live");
    await setzen(13320, "live", "Normalabonnement", "ausland", 1);
    await setzen(9000, "live", "Schüler- und Studentenabonnement", "inland", 10);
    await setzen(100, "test");
    const offers = await t.query(api.plans.offers, {});
    expect(offers).toHaveLength(1);
    expect(offers[0].headline).toMatchObject({ priceAmountCents: 10900, interval: "year" });
    expect(offers[0].tiers.map((x: any) => [x.tier, x.plans.map((p: any) => p.priceAmountCents)])).toEqual([
      ["Normalabonnement", [10900, 13320]],
      ["Schüler- und Studentenabonnement", [9000]],
    ]);

    delete process.env.LESER_STRIPE_MODE;
    expect(await t.query(api.plans.offers, {})).toEqual([]);
  });

  test("Webhook: eigenes Abo schaltet frei, fremde Abos des Ladenkontos nicht", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);

    const fremd = await senden(t, {
      type: "customer.subscription.created",
      data: { object: abo(s, { id: "sub_fremd", metadata: {} }) },
    });
    expect(fremd.status).toBe(200);

    await senden(t, { type: "customer.subscription.created", data: { object: abo(s) } });
    const stand = await t.run(async (ctx: any) => ({
      subs: await ctx.db.query("subscriptions").collect(),
      rechte: await ctx.db.query("entitlements").collect(),
    }));
    expect(stand.subs).toHaveLength(1);
    expect(stand.subs[0]).toMatchObject({ stripeSubscriptionId: "sub_1", stripeModus: "live", status: "active" });
    expect(stand.rechte.map((r: any) => r.issueId)).toEqual([s.heft]);

    const als = t.withIdentity({ subject: `${s.userId}|s` });
    expect((await als.query(api.subscriptions.myStatus, {})).active).toBe(true);

    await senden(t, { type: "customer.subscription.deleted", data: { object: abo(s, { status: "canceled" }) } });
    expect((await als.query(api.subscriptions.myStatus, {})).active).toBe(false);
  });

  test("Webhook: bezahlter Checkout wird als Kauf vermerkt, fremder nicht", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const sitzung = (metadata: Record<string, string>) => ({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "subscription",
          payment_status: "paid",
          amount_total: 4900,
          customer_details: { email: "leser@example.de" },
          metadata,
        },
      },
    });
    await senden(t, sitzung({}));
    expect(await t.run(async (ctx: any) => await ctx.db.query("purchases").collect())).toHaveLength(0);
    await senden(t, sitzung({ source: ABO_HERKUNFT, userId: s.userId }));
    const kaeufe = await t.run(async (ctx: any) => await ctx.db.query("purchases").collect());
    expect(kaeufe).toHaveLength(1);
    expect(kaeufe[0]).toMatchObject({ amountCents: 4900, status: "paid" });
  });

  // --- Kombi-Abo ---

  async function kombiAufbau(t: any) {
    const s = await aufbau(t);
    return await t.run(async (ctx: any) => {
      const now = Date.now();
      const dmz = await ctx.db.insert("publications", { name: "DMZ", slug: "dmz", isActive: true, createdAt: now });
      const dmzHeft = await ctx.db.insert("issues", {
        publicationId: dmz,
        title: "DMZ 1/2026",
        slug: "dmz-1-2026",
        pageCount: 4,
        priceAmountCents: 690,
        isPublished: true,
        publishedAt: now - 1000,
        includedInSubscription: true,
        createdAt: now - 1000,
        updatedAt: now,
      });
      const plan = (publicationId: any, tier: string, cents: number, sortOrder: number) =>
        ctx.db.insert("subscriptionPlans", {
          name: tier,
          tier,
          region: "inland",
          publicationId,
          stripePriceId: `price_${tier}_${cents}`,
          stripeTaxRateId: "txr_1",
          stripeModus: "live",
          priceAmountCents: cents,
          interval: "year",
          isActive: true,
          sortOrder,
          createdAt: now,
        });
      await plan(s.publicationId, "Normalabonnement", 10440, 0);
      const kombi = await plan(s.publicationId, "Kombi-Abonnement", 9600, 20);
      await plan(dmz, "Normalabonnement", 5880, 0);
      return { ...s, dmz, dmzHeft, kombi };
    });
  }

  test("aboAusStripe: gemeinsames Kombi-Abo traegt die Partnerreihe aus den Posten", () => {
    const a = aboAusStripe(
      abo(
        { userId: "u", publicationId: "p_zuerst" },
        {
          items: {
            data: [
              { price: { id: "price_k", metadata: { publicationId: "p_zuerst" } } },
              { price: { id: "price_d", metadata: { publicationId: "p_dmz" } } },
            ],
          },
          metadata: { source: ABO_HERKUNFT, userId: "u", publicationId: "p_zuerst", kombi: "zusammen" },
        },
      ),
      "live",
    );
    expect(a).toMatchObject({ publicationId: "p_zuerst", weitereReihen: ["p_dmz"], kombi: "zusammen", stripePriceId: "price_k" });
  });

  test("gemeinsames Kombi-Abo schaltet beide Reihen frei", async () => {
    const t = convexTest(schema, modules);
    const s = await kombiAufbau(t);
    await t.mutation(internal.subscriptions.upsertFromStripe, {
      userId: s.userId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_k",
      status: "active",
      startedAt: Date.now() - 60_000,
      currentPeriodEnd: Date.now() + 365 * 86400_000,
      publicationId: s.publicationId,
      weitereReihen: [s.dmz],
      kombi: "zusammen",
      stripeModus: "live",
    });
    const freigeschaltet = await t.run(async (ctx: any) =>
      (await ctx.db.query("entitlements").collect()).map((e: any) => e.issueId),
    );
    expect(freigeschaltet.sort()).toEqual([s.heft, s.dmzHeft].sort());
    const als = t.withIdentity({ subject: `${s.userId}|sitzung` });
    expect((await als.query(api.subscriptions.myStatus, {})).subscriptions[0].publication).toBe("ZUERST! und DMZ");
  });

  test("Kombi-Angebot: Preis zusammen, eigenes DMZ-Abo erkannt, Hinweis auf der DMZ-Seite", async () => {
    const t = convexTest(schema, modules);
    const s = await kombiAufbau(t);
    const als = t.withIdentity({ subject: `${s.userId}|sitzung` });
    const ohne = await als.query(api.leserAbo.kombiAngebot, { slug: "zuerst" });
    expect(ohne.stufen).toEqual([
      expect.objectContaining({ planId: s.kombi, partnerName: "DMZ", zusammenCents: 9600 + 5880, vorhanden: false }),
    ]);
    // Auf der DMZ-Seite: Kombi mit ZUERST!, beide zusammen.
    expect((await als.query(api.leserAbo.kombiAngebot, { slug: "dmz" })).alsPartner).toEqual([
      {
        reiheName: "ZUERST!",
        reiheSlug: "zuerst",
        tier: "Kombi-Abonnement",
        planId: s.kombi,
        kombiCents: 9600,
        zusammenCents: 9600 + 5880,
        vorhanden: false,
        eigenesAbo: false,
      },
    ]);

    // Digital-Abo der DMZ aus dem Netzladen genuegt.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("shopAccess", {
        email: "leser@example.de",
        externalOrderId: "1",
        lineId: "1",
        sku: "dmz-abo",
        kind: "subscription",
        publicationId: s.dmz,
        validFrom: Date.now() - 1000,
        validUntil: Date.now() + 86400_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const mit = await als.query(api.leserAbo.kombiAngebot, { slug: "zuerst" });
    expect(mit.stufen[0].vorhanden).toBe(true);
    expect((await als.query(api.leserAbo.kombiAngebot, { slug: "dmz" })).alsPartner[0]).toMatchObject({
      vorhanden: true,
      eigenesAbo: false,
    });
  });

  test("Kombi ohne DMZ-Abo wird vor der Verlaengerung auf den Normalpreis gestellt", async () => {
    const t = convexTest(schema, modules);
    const s = await kombiAufbau(t);
    const anlegen = (periodenEnde: number) =>
      t.mutation(internal.subscriptions.upsertFromStripe, {
        userId: s.userId,
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_v",
        stripePriceId: "price_Kombi-Abonnement_9600",
        status: "active",
        startedAt: Date.now() - 300 * 86400_000,
        currentPeriodEnd: periodenEnde,
        publicationId: s.publicationId,
        kombi: "vorhanden",
        stripeModus: "live",
      });
    await anlegen(Date.now() + 30 * 86400_000);
    expect(await t.query(internal.leserAbo.kombiFaellig, { modus: "live" })).toEqual([]);
    await anlegen(Date.now() + 2 * 86400_000);
    expect(await t.query(internal.leserAbo.kombiFaellig, { modus: "live" })).toEqual([
      { stripeSubscriptionId: "sub_v", preisId: "price_Normalabonnement_10440", steuerId: "txr_1", name: "Normalabonnement" },
    ]);
    // Mit laufendem DMZ-Abo im Leser bleibt der Kombipreis.
    await t.mutation(internal.subscriptions.upsertFromStripe, {
      userId: s.userId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_dmz",
      status: "active",
      startedAt: Date.now() - 60_000,
      currentPeriodEnd: Date.now() + 365 * 86400_000,
      publicationId: s.dmz,
      stripeModus: "live",
    });
    expect(await t.query(internal.leserAbo.kombiFaellig, { modus: "live" })).toEqual([]);
  });
});
