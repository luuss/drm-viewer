import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  adressePruefen,
  kartenName,
  kaufMetadaten,
  naechsterVersuchMs,
  signaturBilden,
  stripeKonfig,
  webhookPruefen,
} from "./leserStripe";

const modules = import.meta.glob("./**/*.ts");

const WH_TEST = "whsec_test_geheimnis";
const WH_LIVE = "whsec_live_geheimnis";

const ADRESSE = {
  vorname: "Erika",
  nachname: "Mustermann",
  strasse: "Hauptstraße 1",
  plz: "10115",
  ort: "Berlin",
  land: "DE",
};

describe("leserStripe: Konfiguration", () => {
  test("aus ohne Modus oder mit Schluesseln des falschen Modus", () => {
    expect(stripeKonfig({})).toBeNull();
    expect(
      stripeKonfig({
        LESER_STRIPE_MODE: "live",
        LESER_STRIPE_SECRET_KEY_LIVE: "sk_test_abc",
        LESER_STRIPE_PUBLISHABLE_KEY_LIVE: "pk_test_abc",
      }),
    ).toBeNull();
  });

  test("Testmodus mit passenden Schluesseln", () => {
    expect(
      stripeKonfig({
        LESER_STRIPE_MODE: "test",
        LESER_STRIPE_SECRET_KEY_TEST: "sk_test_abc",
        LESER_STRIPE_PUBLISHABLE_KEY_TEST: "pk_test_abc",
        LESER_STRIPE_SECRET_KEY_LIVE: "sk_live_xyz",
      }),
    ).toEqual({ modus: "test", secretKey: "sk_test_abc", publishableKey: "pk_test_abc" });
  });
});

describe("leserStripe: Webhook-Signatur", () => {
  const rumpf = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
  const geheimnisse = [
    { modus: "live" as const, secret: WH_LIVE },
    { modus: "test" as const, secret: WH_TEST },
  ];

  test("erkennt den Modus am Geheimnis", async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await webhookPruefen(rumpf, await signaturBilden(rumpf, WH_TEST, t), geheimnisse)).toBe("test");
    expect(await webhookPruefen(rumpf, await signaturBilden(rumpf, WH_LIVE, t), geheimnisse)).toBe("live");
  });

  test("lehnt fremdes Geheimnis, veraenderten Rumpf und alte Zeitstempel ab", async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await webhookPruefen(rumpf, await signaturBilden(rumpf, "whsec_x", t), geheimnisse)).toBeNull();
    expect(await webhookPruefen(`${rumpf} `, await signaturBilden(rumpf, WH_TEST, t), geheimnisse)).toBeNull();
    expect(await webhookPruefen(rumpf, await signaturBilden(rumpf, WH_TEST, t - 600), geheimnisse)).toBeNull();
    expect(await webhookPruefen(rumpf, null, geheimnisse)).toBeNull();
    expect(await webhookPruefen(rumpf, "t=1,v0=abc", geheimnisse)).toBeNull();
  });
});

describe("leserStripe: Adresse und Kleinteile", () => {
  test("Adresse wird bereinigt und geprueft", () => {
    expect(adressePruefen({ ...ADRESSE, vorname: "  Erika ", land: "de" })).toMatchObject({
      vorname: "Erika",
      land: "DE",
    });
    expect(() => adressePruefen({ ...ADRESSE, plz: "1011" })).toThrow(/Postleitzahl/);
    expect(() => adressePruefen({ ...ADRESSE, nachname: "Muster1" })).toThrow(/Zeichen/);
    expect(() => adressePruefen({ ...ADRESSE, land: "XX" })).toThrow(/Land/);
    expect(() => adressePruefen({ ...ADRESSE, strasse: " " })).toThrow(/Straße/);
    expect(adressePruefen({ ...ADRESSE, land: "AT", plz: "1010" }).plz).toBe("1010");
  });

  test("Kartenname, Metadaten, Wartezeiten", () => {
    expect(kartenName({ marke: "visa", letzte4: "4242" })).toBe("Visa •••• 4242");
    const m = kaufMetadaten({ kaufId: "k1", userId: "u1", email: "a@b.de", skus: ["A", "B"] });
    expect(m).toMatchObject({ source: "leser", kaufId: "k1", skus: "A,B" });
    expect(naechsterVersuchMs(0)).toBe(30_000);
    expect(naechsterVersuchMs(7)).toBe(12 * 3600_000);
    expect(naechsterVersuchMs(8)).toBeNull();
  });
});

// --- Convex ----------------------------------------------------------------

async function aufbau(t: any, opts: { email?: string } = {}) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: opts.email ?? "Leser@Example.de" });
    const publicationId = await ctx.db.insert("publications", {
      name: "Schwerterträger",
      slug: "schwertertraeger",
      isActive: true,
      createdAt: now,
    });
    const heft = (sku: string | null, published = true) =>
      ctx.db.insert("issues", {
        publicationId,
        title: `Heft ${sku}`,
        slug: `heft-${sku}-${Math.random().toString(36).slice(2)}`,
        pageCount: 4,
        priceAmountCents: 1380,
        isPublished: published,
        includedInSubscription: false,
        externalSku: sku ?? undefined,
        shopDigital: sku ? { offered: true, sku, syncedAt: now } : undefined,
        createdAt: now,
        updatedAt: now,
      });
    return {
      userId: userId as Id<"users">,
      greim: (await heft("ST-36-DIGITAL")) as Id<"issues">,
      zweites: (await heft("ST-37-DIGITAL")) as Id<"issues">,
      ohneShop: (await heft(null)) as Id<"issues">,
      entwurf: (await heft("ST-38-DIGITAL", false)) as Id<"issues">,
    };
  });
}

async function kaufAnlegen(t: any, userId: Id<"users">, issueIds: Id<"issues">[], pi = "pi_TEST12345678") {
  const kaufId: Id<"leserKaeufe"> = await t.mutation(internal.leserKasse.kaufAnlegen, {
    userId,
    email: "leser@example.de",
    modus: "test",
    issueIds,
    skus: ["ST-36-DIGITAL"],
    betragCents: 1380,
    karteGespeichert: false,
  });
  await t.mutation(internal.leserKasse.zahlungVermerken, { kaufId, paymentIntentId: pi });
  return kaufId;
}

async function geplant(t: any): Promise<any[]> {
  return await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect());
}

describe("leserKasse", () => {
  beforeEach(() => {
    // Geplante Aktionen (Stripe, Shop) sollen im Test nicht laufen.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.LESER_STRIPE_MODE;
    delete process.env.LESER_STRIPE_SECRET_KEY_TEST;
    delete process.env.LESER_STRIPE_PUBLISHABLE_KEY_TEST;
    delete process.env.LESER_STRIPE_WEBHOOK_SECRET_TEST;
  });

  test("kaufVorbereiten prueft Hefte und liefert die Artikelnummern", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const r = await t.query(internal.leserKasse.kaufVorbereiten, {
      userId: s.userId,
      issueIds: [s.greim, s.greim, s.zweites],
      modus: "test",
    });
    expect(r.email).toBe("leser@example.de");
    expect(r.hefte.map((h: any) => h.sku)).toEqual(["ST-36-DIGITAL", "ST-37-DIGITAL"]);
    expect(r.adresse).toBeNull();

    await expect(
      t.query(internal.leserKasse.kaufVorbereiten, { userId: s.userId, issueIds: [s.ohneShop], modus: "test" }),
    ).rejects.toThrow(/nicht als Digitalausgabe/);
    await expect(
      t.query(internal.leserKasse.kaufVorbereiten, { userId: s.userId, issueIds: [s.entwurf], modus: "test" }),
    ).rejects.toThrow(/nicht mehr erhältlich/);
  });

  test("ein schon gekauftes Heft laesst sich nicht noch einmal kaufen", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    await t.mutation(internal.shopIntegration.applyOrderInternal, {
      externalOrderId: "300",
      email: "leser@example.de",
      action: "grant",
      items: [{ sku: "ST-36-DIGITAL", lineId: "1" }],
    });
    await expect(
      t.query(internal.leserKasse.kaufVorbereiten, { userId: s.userId, issueIds: [s.greim], modus: "test" }),
    ).rejects.toThrow(/schon zu Ihrer Bibliothek/);
  });

  test("Zahlung vermerkt Widerrufsverzicht je Heft", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    await kaufAnlegen(t, s.userId, [s.greim, s.zweites], "pi_VERZICHT1234");
    const consents = await t.run(async (ctx: any) => await ctx.db.query("consents").collect());
    expect(consents).toHaveLength(2);
    expect(consents[0]).toMatchObject({ type: "withdrawal_waiver", stripeSessionId: "pi_VERZICHT1234" });
  });

  test("zahlungEingegangen plant die Bestellung genau einmal", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const kaufId = await kaufAnlegen(t, s.userId, [s.greim]);
    const args = {
      paymentIntentId: "pi_TEST12345678",
      betragCents: 1380,
      modus: "test" as const,
      paymentMethodId: "pm_1",
      karteSpeichern: true,
    };
    expect(await t.mutation(internal.leserKasse.zahlungEingegangen, args)).toEqual({ neu: true });
    expect(await t.mutation(internal.leserKasse.zahlungEingegangen, args)).toEqual({ neu: false });
    const plan = await geplant(t);
    expect(plan.map((p) => p.name).sort()).toEqual([
      "leserZahlung:bestellungAnlegen",
      "leserZahlung:karteMerken",
    ]);
    const kauf = await t.run(async (ctx: any) => await ctx.db.get(kaufId));
    expect(kauf.status).toBe("bezahlt");

    expect(
      await t.mutation(internal.leserKasse.zahlungEingegangen, { ...args, paymentIntentId: "pi_FREMD12345678" }),
    ).toEqual({ neu: false });
  });

  test("Bestellergebnis: Erfolg, Wiederholung, Aufgabe", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const kaufId = await kaufAnlegen(t, s.userId, [s.greim]);
    await t.mutation(internal.leserKasse.zahlungEingegangen, {
      paymentIntentId: "pi_TEST12345678",
      betragCents: 1380,
      modus: "test",
      karteSpeichern: false,
    });

    await t.mutation(internal.leserKasse.bestellungErgebnis, {
      kaufId,
      ok: false,
      wiederholen: true,
      fehler: "busy",
    });
    let kauf = await t.run(async (ctx: any) => await ctx.db.get(kaufId));
    expect(kauf).toMatchObject({ status: "bezahlt", versuche: 1, fehler: "busy" });
    expect((await geplant(t)).filter((p) => p.name === "leserZahlung:bestellungAnlegen")).toHaveLength(2);

    await t.run(async (ctx: any) => await ctx.db.patch(kaufId, { versuche: 8 }));
    await t.mutation(internal.leserKasse.bestellungErgebnis, { kaufId, ok: false, wiederholen: true, fehler: "tot" });
    kauf = await t.run(async (ctx: any) => await ctx.db.get(kaufId));
    expect(kauf.status).toBe("fehler");

    await t.mutation(internal.leserKasse.bestellungErgebnis, {
      kaufId,
      ok: true,
      wiederholen: false,
      shopOrderId: 291,
      shopReference: "ABCDEFGHI",
      shopState: 2,
      bezahltImShop: true,
    });
    kauf = await t.run(async (ctx: any) => await ctx.db.get(kaufId));
    expect(kauf).toMatchObject({ status: "bestellt", shopOrderId: 291, shopReference: "ABCDEFGHI" });
    expect(kauf.fehler).toBeUndefined();
  });

  test("Betragsabweichung im Shop endet als Fehler, nicht als bestellt", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const kaufId = await kaufAnlegen(t, s.userId, [s.greim]);
    await t.mutation(internal.leserKasse.bestellungErgebnis, {
      kaufId,
      ok: true,
      wiederholen: false,
      shopOrderId: 292,
      shopState: 8,
      bezahltImShop: false,
      fehler: "Betrag weicht ab",
    });
    const kauf = await t.run(async (ctx: any) => await ctx.db.get(kaufId));
    expect(kauf).toMatchObject({ status: "fehler", fehler: "Betrag weicht ab" });
  });

  test("Karte nur zum eigenen Stripe-Kunden, sichtbar in status, entfernbar", async () => {
    process.env.LESER_STRIPE_MODE = "test";
    process.env.LESER_STRIPE_SECRET_KEY_TEST = "sk_test_x";
    process.env.LESER_STRIPE_PUBLISHABLE_KEY_TEST = "pk_test_x";
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    await t.mutation(internal.leserKasse.kundeMerken, { userId: s.userId, modus: "test", stripeCustomerId: "cus_A" });
    const karte = {
      userId: s.userId,
      modus: "test" as const,
      paymentMethodId: "pm_1",
      marke: "visa",
      letzte4: "4242",
      ablaufMonat: 12,
      ablaufJahr: 2034,
    };
    await t.mutation(internal.leserKasse.karteSetzen, { ...karte, stripeCustomerId: "cus_FREMD" });
    const als = t.withIdentity({ subject: `${s.userId}|sitzung` });
    expect((await als.query(api.leserKasse.status, {})).karte).toBeNull();

    await t.mutation(internal.leserKasse.karteSetzen, { ...karte, stripeCustomerId: "cus_A" });
    const st: any = await als.query(api.leserKasse.status, {});
    expect(st).toMatchObject({ aktiv: true, modus: "test", publishableKey: "pk_test_x" });
    expect(st.karte).toMatchObject({ name: "Visa •••• 4242", ablauf: "12/34" });

    await t.mutation(internal.leserKasse.karteVergessen, { userId: s.userId, modus: "test" });
    expect((await als.query(api.leserKasse.status, {})).karte).toBeNull();
  });

  test("Kasse ist aus, solange kein Modus gesetzt ist", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.leserKasse.status, {})).toMatchObject({ aktiv: false });
  });

  test("kaufStatus nur fuer den Kaeufer, mit Freischaltung", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const kaufId = await kaufAnlegen(t, s.userId, [s.greim]);
    const fremd = await t.run(async (ctx: any) => await ctx.db.insert("users", { email: "x@y.de" }));
    expect(await t.withIdentity({ subject: `${fremd}|s` }).query(api.leserKasse.kaufStatus, { kaufId })).toBeNull();
    const als = t.withIdentity({ subject: `${s.userId}|s` });
    expect(await als.query(api.leserKasse.kaufStatus, { kaufId })).toMatchObject({
      status: "angelegt",
      freigeschaltet: false,
    });
    await t.mutation(internal.shopIntegration.applyOrderInternal, {
      externalOrderId: "301",
      email: "LESER@example.de",
      action: "grant",
      items: [{ sku: "ST-36-DIGITAL", lineId: "7" }],
    });
    expect(await als.query(api.leserKasse.kaufStatus, { kaufId })).toMatchObject({ freigeschaltet: true });
  });

  test("Adresse speichern prueft und ersetzt", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const als = t.withIdentity({ subject: `${s.userId}|s` });
    await expect(als.mutation(api.leserKasse.adresseSpeichern, { adresse: { ...ADRESSE, plz: "x" } })).rejects.toThrow();
    await als.mutation(api.leserKasse.adresseSpeichern, { adresse: ADRESSE });
    await als.mutation(api.leserKasse.adresseSpeichern, { adresse: { ...ADRESSE, ort: "Potsdam", plz: "14467" } });
    const zeilen = await t.run(async (ctx: any) => await ctx.db.query("leserKunden").collect());
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({ ort: "Potsdam" });
  });
});

describe("Kontoloeschung", () => {
  test("nimmt Adresse und Karte mit, Kaeufe bleiben anonym", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const als = t.withIdentity({ subject: `${s.userId}|s` });
    await als.mutation(api.leserKasse.adresseSpeichern, { adresse: ADRESSE });
    await t.mutation(internal.leserKasse.kundeMerken, { userId: s.userId, modus: "test", stripeCustomerId: "cus_A" });
    const kaufId = await kaufAnlegen(t, s.userId, [s.greim]);
    await t.mutation(internal.account.purgeUserData, { userId: s.userId });
    const rest = await t.run(async (ctx: any) => ({
      kunden: await ctx.db.query("leserKunden").take(5),
      karten: await ctx.db.query("leserKarten").take(5),
      kauf: await ctx.db.get(kaufId),
    }));
    expect(rest.kunden).toHaveLength(0);
    expect(rest.karten).toHaveLength(0);
    expect(rest.kauf.email).toBe("geloescht");
    vi.useRealTimers();
  });
});

describe("Stripe-Webhook /stripe/webhook", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    process.env.LESER_STRIPE_WEBHOOK_SECRET_TEST = WH_TEST;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.LESER_STRIPE_WEBHOOK_SECRET_TEST;
  });

  async function senden(t: any, event: any, secret = WH_TEST) {
    const rumpf = JSON.stringify(event);
    const sig = await signaturBilden(rumpf, secret, Math.floor(Date.now() / 1000));
    return await t.fetch("/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": sig, "content-type": "application/json" },
      body: rumpf,
    });
  }

  test("eigene Zahlung wird verbucht, fremde und falsch signierte nicht", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    const kaufId = await kaufAnlegen(t, s.userId, [s.greim]);

    const falsch = await senden(t, { type: "payment_intent.succeeded", data: { object: {} } }, "whsec_falsch");
    expect(falsch.status).toBe(400);

    const shop = await senden(t, {
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_TEST12345678", amount_received: 1380, metadata: { id_cart: "5" } } },
    });
    expect(shop.status).toBe(200);
    expect((await t.run(async (ctx: any) => await ctx.db.get(kaufId))).status).toBe("angelegt");

    const eigen = await senden(t, {
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_TEST12345678",
          amount_received: 1380,
          payment_method: "pm_1",
          setup_future_usage: "on_session",
          metadata: { source: "leser", kaufId },
        },
      },
    });
    expect(eigen.status).toBe(200);
    expect((await t.run(async (ctx: any) => await ctx.db.get(kaufId))).status).toBe("bezahlt");
  });

  test("Erstattung zu einem Leser-Kauf wird an den Shop weitergereicht", async () => {
    const t = convexTest(schema, modules);
    const s = await aufbau(t);
    await kaufAnlegen(t, s.userId, [s.greim]);
    await senden(t, { type: "charge.refunded", data: { object: { payment_intent: "pi_TEST12345678" } } });
    await senden(t, { type: "charge.refunded", data: { object: { payment_intent: "pi_SHOP12345678" } } });
    const plan = await geplant(t);
    expect(plan.map((p) => [p.name, p.args[0].paymentIntentId])).toEqual([
      ["leserZahlung:erstattungMelden", "pi_TEST12345678"],
    ]);
  });
});

describe("stripeRest", () => {
  test("Formular kodiert verschachtelte Parameter wie Stripe", async () => {
    const { formular } = await import("./stripeRest");
    expect(
      formular({
        amount: 1380,
        payment_method_types: ["card"],
        metadata: { source: "leser", skus: "A,B" },
        leer: undefined,
      }).join("&"),
    ).toBe(
      "amount=1380&payment_method_types%5B0%5D=card&metadata%5Bsource%5D=leser&metadata%5Bskus%5D=A%2CB",
    );
  });

  test("Kartenfehler kommt mit Code und PaymentIntent zurueck", async () => {
    const { stripeClient, StripeFehler } = await import("./stripeRest");
    const fetchFalsch = (async () =>
      new Response(
        JSON.stringify({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", payment_intent: { id: "pi_1" } } }),
        { status: 402 },
      )) as unknown as typeof fetch;
    const s = stripeClient("sk_test_x", fetchFalsch);
    const e: any = await s("POST", "payment_intents", { amount: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(StripeFehler);
    expect(e).toMatchObject({ type: "card_error", declineCode: "insufficient_funds", status: 402 });
    expect(e.paymentIntent.id).toBe("pi_1");
  });
});
