import { v } from "convex/values";
import { action, internalMutation, internalQuery, ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./access";
import { audit, requireAdmin } from "./roles";
import { WITHDRAWAL_WAIVER_TEXT, WITHDRAWAL_WAIVER_VERSION } from "./consents";
import { StripeKonfig, StripeModus, secretKeyFuer, stripeKonfig } from "./leserStripe";
import { StripeAufruf, stripeClient } from "./stripeRest";

/**
 * Digital-Jahresabo ueber Stripe Checkout, im Stripe-Konto des Ladens — mit
 * denselben Schluesseln, demselben Modus (`LESER_STRIPE_MODE`) und demselben
 * Webhook wie der Kartenkauf im Leser (leserZahlung.ts). Stripe bucht jedes
 * Jahr selbst ab; der Webhook spiegelt das Abo nach `subscriptions`, und
 * `subscriptions.upsertFromStripe` schaltet die Hefte der Reihe frei.
 *
 * Bewusst ohne `"use node"` und ohne Stripe-SDK (stripeRest.ts).
 *
 * Steuer: Stripe Tax ist im Konto nicht eingerichtet. Die Rechnung traegt
 * einen festen Steuersatz (7 % MwSt., elektronische Zeitschrift), im Preis
 * enthalten.
 */

/** Kennung an Checkout, Abo, Produkt und Preis: nur diese Objekte gehoeren uns. */
export const ABO_HERKUNFT = "leser-abo";

const STEUERSATZ_PROZENT = 7;

function konfigOderFehler(): StripeKonfig {
  const k = stripeKonfig();
  if (!k) throw new Error("Die Zahlung mit Stripe ist im Leser nicht eingerichtet.");
  return k;
}

async function angemeldet(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Bitte zuerst anmelden.");
  return userId as Id<"users">;
}

/** Stripe liefert Sekunden; das Abo-Ende steht je nach API-Version am Abo oder am Posten. */
function ms(s: number | null | undefined): number | undefined {
  return s == null ? undefined : s * 1000;
}

/** Abo-Objekt aus Stripe als Argumente fuer `subscriptions.upsertFromStripe`. */
export function aboAusStripe(s: any, modus: StripeModus, geloescht = false) {
  const posten = s?.items?.data?.[0];
  return {
    stripeSubscriptionId: String(s.id),
    stripeCustomerId: typeof s.customer === "string" ? s.customer : String(s.customer?.id ?? ""),
    stripePriceId: posten?.price?.id ?? undefined,
    status: geloescht ? "canceled" : String(s.status),
    startedAt: ms(s.start_date),
    currentPeriodEnd: ms(s.current_period_end ?? posten?.current_period_end),
    cancelAtPeriodEnd: geloescht ? true : Boolean(s.cancel_at_period_end),
    endedAt: geloescht ? (ms(s.ended_at) ?? Date.now()) : ms(s.ended_at),
    userId: s.metadata?.userId || undefined,
    publicationId: s.metadata?.publicationId || undefined,
    stripeModus: modus,
  };
}

// --- Preis anlegen (Redaktion) --------------------------------------------------

export const reiheFuerPreis = internalQuery({
  args: { publicationId: v.id("publications"), modus: v.union(v.literal("test"), v.literal("live")) },
  handler: async (ctx, { publicationId, modus }) => {
    await requireAdmin(ctx);
    const publication = await ctx.db.get(publicationId);
    if (!publication) throw new Error("Reihe nicht gefunden");
    const plaene = await ctx.db
      .query("subscriptionPlans")
      .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
      .collect();
    const eigene = plaene.filter((p) => p.stripeModus === modus);
    return {
      name: publication.name,
      // Das Produkt bleibt bei einem neuen Preis dasselbe.
      productId: eigene.find((p) => p.stripeProductId)?.stripeProductId ?? null,
    };
  },
});

/** Neuer Preis wird der aktive; fruehere Preise derselben Reihe gehen aus dem Verkauf. */
export const planSetzen = internalMutation({
  args: {
    publicationId: v.id("publications"),
    modus: v.union(v.literal("test"), v.literal("live")),
    priceAmountCents: v.number(),
    stripePriceId: v.string(),
    stripeProductId: v.string(),
    stripeTaxRateId: v.string(),
  },
  handler: async (ctx, a) => {
    const plaene = await ctx.db
      .query("subscriptionPlans")
      .withIndex("by_publication", (q) => q.eq("publicationId", a.publicationId))
      .collect();
    for (const p of plaene) {
      if (p.isActive && p.stripeModus === a.modus) await ctx.db.patch(p._id, { isActive: false });
    }
    const id = await ctx.db.insert("subscriptionPlans", {
      name: "Jahresabo",
      tier: "Jahresabo",
      publicationId: a.publicationId,
      stripePriceId: a.stripePriceId,
      stripeProductId: a.stripeProductId,
      stripeTaxRateId: a.stripeTaxRateId,
      stripeModus: a.modus,
      priceAmountCents: a.priceAmountCents,
      interval: "year",
      isActive: true,
      sortOrder: 0,
      createdAt: Date.now(),
    });
    await audit(ctx, "abo.preis", a.publicationId, `${a.priceAmountCents} Cent (${a.modus})`);
    return id;
  },
});

/** Jahresabo einer Reihe aus dem Verkauf nehmen; laufende Abos laufen weiter. */
export const verkaufBeenden = internalMutation({
  args: { publicationId: v.id("publications"), modus: v.union(v.literal("test"), v.literal("live")) },
  handler: async (ctx, { publicationId, modus }) => {
    await requireAdmin(ctx);
    const plaene = await ctx.db
      .query("subscriptionPlans")
      .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
      .collect();
    for (const p of plaene) {
      if (p.isActive && p.stripeModus === modus) await ctx.db.patch(p._id, { isActive: false });
    }
    await audit(ctx, "abo.verkaufBeendet", publicationId, modus);
  },
});

async function steuersatz(stripe: StripeAufruf): Promise<string> {
  const liste = await stripe("GET", "tax_rates", { active: "true", inclusive: "true", limit: 100 });
  const da = (liste?.data ?? []).find(
    (t: any) => t.metadata?.source === ABO_HERKUNFT && Number(t.percentage) === STEUERSATZ_PROZENT,
  );
  if (da) return da.id;
  const neu = await stripe(
    "POST",
    "tax_rates",
    {
      display_name: "MwSt.",
      description: "Elektronische Zeitschrift",
      percentage: STEUERSATZ_PROZENT,
      inclusive: true,
      country: "DE",
      jurisdiction: "DE",
      metadata: { source: ABO_HERKUNFT },
    },
    `leser-abo-steuer-${STEUERSATZ_PROZENT}`,
  );
  return neu.id;
}

/**
 * Preis des Jahresabos einer Reihe setzen (Redaktion → Einstellungen). Legt
 * bei Stripe Produkt (einmal je Reihe), Jahrespreis und Steuersatz an. Ein
 * neuer Preis gilt fuer neue Abschluesse; laufende Abos behalten ihren.
 * `priceAmountCents: null` nimmt das Abo aus dem Verkauf.
 */
export const preisSetzen = action({
  args: { publicationId: v.id("publications"), priceAmountCents: v.union(v.number(), v.null()) },
  handler: async (ctx, { publicationId, priceAmountCents }): Promise<null> => {
    const konfig = konfigOderFehler();
    if (priceAmountCents === null) {
      await ctx.runMutation(internal.leserAbo.verkaufBeenden, { publicationId, modus: konfig.modus });
      return null;
    }
    if (!Number.isInteger(priceAmountCents) || priceAmountCents < 100 || priceAmountCents > 100_000) {
      throw new Error("Preis in Cent zwischen 1 € und 1000 €");
    }
    // Prueft auch die Rolle.
    const reihe = await ctx.runQuery(internal.leserAbo.reiheFuerPreis, {
      publicationId,
      modus: konfig.modus,
    });
    const stripe = stripeClient(konfig.secretKey);
    const productId =
      reihe.productId ??
      (
        await stripe(
          "POST",
          "products",
          {
            name: `${reihe.name} Digital-Jahresabo`,
            metadata: { source: ABO_HERKUNFT, publicationId },
          },
          `leser-abo-produkt-${publicationId}-${konfig.modus}`,
        )
      ).id;
    const preis = await stripe(
      "POST",
      "prices",
      {
        product: productId,
        unit_amount: priceAmountCents,
        currency: "eur",
        recurring: { interval: "year" },
        tax_behavior: "inclusive",
        metadata: { source: ABO_HERKUNFT, publicationId },
      },
      `leser-abo-preis-${publicationId}-${konfig.modus}-${priceAmountCents}`,
    );
    await ctx.runMutation(internal.leserAbo.planSetzen, {
      publicationId,
      modus: konfig.modus,
      priceAmountCents,
      stripePriceId: preis.id,
      stripeProductId: productId,
      stripeTaxRateId: await steuersatz(stripe),
    });
    return null;
  },
});

// --- Abschluss -------------------------------------------------------------------

export const abschlussVorbereiten = internalQuery({
  args: {
    userId: v.id("users"),
    planId: v.id("subscriptionPlans"),
    modus: v.union(v.literal("test"), v.literal("live")),
  },
  handler: async (ctx, { userId, planId, modus }) => {
    const user = await ctx.db.get(userId);
    const email = normalizeEmail(user?.email);
    if (!email) throw new Error("Das Konto hat keine E-Mail-Adresse.");
    const plan = await ctx.db.get(planId);
    if (!plan || !plan.isActive || plan.stripeModus !== modus || !plan.stripeTaxRateId) {
      throw new Error("Dieses Abo ist nicht mehr erhältlich.");
    }
    const publication = await ctx.db.get(plan.publicationId);
    if (!publication?.isActive) throw new Error("Dieses Abo ist nicht mehr erhältlich.");
    const karte = await ctx.db
      .query("leserKarten")
      .withIndex("by_user_modus", (q) => q.eq("userId", userId).eq("modus", modus))
      .unique();
    return {
      email,
      plan: plan as Doc<"subscriptionPlans">,
      reihe: publication.name,
      slug: publication.slug,
      stripeCustomerId: karte?.stripeCustomerId ?? null,
    };
  },
});

export const verzichtVermerken = internalMutation({
  args: {
    userId: v.id("users"),
    email: v.string(),
    planId: v.id("subscriptionPlans"),
    sessionId: v.string(),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("consents", {
      userId: a.userId,
      email: a.email,
      type: "withdrawal_waiver",
      documentVersion: WITHDRAWAL_WAIVER_VERSION,
      text: WITHDRAWAL_WAIVER_TEXT,
      planId: a.planId,
      stripeSessionId: a.sessionId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("auditLog", {
      actorUserId: a.userId,
      actorEmail: a.email,
      action: "abo.checkout",
      target: a.sessionId,
      detail: `Plan ${a.planId}`,
      createdAt: Date.now(),
    });
  },
});

/** Derselbe Stripe-Kunde wie beim Kartenkauf, sonst ein neuer. */
async function kundeFuer(
  ctx: ActionCtx,
  stripe: StripeAufruf,
  konfig: StripeKonfig,
  userId: Id<"users">,
  email: string,
  vorhanden: string | null,
): Promise<string> {
  if (vorhanden) return vorhanden;
  const kunde = await stripe(
    "POST",
    "customers",
    { email, metadata: { source: "leser", leserUserId: userId } },
    `leser-kunde-${userId}-${konfig.modus}`,
  );
  await ctx.runMutation(internal.leserKasse.kundeMerken, {
    userId,
    modus: konfig.modus,
    stripeCustomerId: kunde.id,
  });
  return kunde.id;
}

/** Ziel nach dem Checkout: nur Pfade dieser Seite. */
function eigeneAdresse(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.hostname === "localhost" ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Jahresabo abschliessen: oeffnet Stripe Checkout. Der Widerrufsverzicht wird
 * zur Sitzung belegt; das Abo selbst kommt ueber den Webhook.
 */
export const abschliessen = action({
  args: {
    planId: v.id("subscriptionPlans"),
    widerrufsverzicht: v.boolean(),
    successUrl: v.string(),
    cancelUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const konfig = konfigOderFehler();
    const userId = await angemeldet(ctx);
    if (!args.widerrufsverzicht) {
      throw new Error(
        "Ohne Zustimmung zum sofortigen Zugriff (Widerrufsverzicht) ist kein Abo möglich.",
      );
    }
    const vb = await ctx.runQuery(internal.leserAbo.abschlussVorbereiten, {
      userId,
      planId: args.planId,
      modus: konfig.modus,
    });
    const stripe = stripeClient(konfig.secretKey);
    const kunde = await kundeFuer(ctx, stripe, konfig, userId, vb.email, vb.stripeCustomerId);
    const merkmale = {
      source: ABO_HERKUNFT,
      planId: args.planId,
      userId,
      publicationId: vb.plan.publicationId,
    };
    const sitzung = await stripe("POST", "checkout/sessions", {
      mode: "subscription",
      customer: kunde,
      line_items: [{ price: vb.plan.stripePriceId, quantity: 1, tax_rates: [vb.plan.stripeTaxRateId] }],
      success_url: eigeneAdresse(args.successUrl, "https://digital.lesenundschenken.de/library?abo=1"),
      cancel_url: eigeneAdresse(args.cancelUrl, `https://digital.lesenundschenken.de/abo/${vb.slug}`),
      locale: "de",
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      metadata: merkmale,
      subscription_data: {
        description: `${vb.reihe} Digital-Jahresabo`,
        metadata: merkmale,
      },
    });
    await ctx.runMutation(internal.leserAbo.verzichtVermerken, {
      userId,
      email: vb.email,
      planId: args.planId,
      sessionId: sitzung.id,
    });
    if (!sitzung.url) throw new Error("Stripe lieferte keine Adresse für den Checkout.");
    return { url: sitzung.url };
  },
});

// --- Verwaltung im Profil ---------------------------------------------------------

/** Kuendigen zum Laufzeitende oder die Kuendigung zuruecknehmen. */
export const kuendigen = action({
  args: { stripeSubscriptionId: v.string(), zuruecknehmen: v.optional(v.boolean()) },
  handler: async (ctx, { stripeSubscriptionId, zuruecknehmen }): Promise<null> => {
    const userId = await angemeldet(ctx);
    const sub = await ctx.runQuery(internal.subscriptions.ownedInternal, {
      userId,
      stripeSubscriptionId,
    });
    if (!sub) throw new Error("Abo gehört nicht zu diesem Konto");
    if (!sub.stripeModus) {
      // Abo aus dem alten eigenen Checkout.
      await ctx.runAction(api.billing.cancelMySubscription, { stripeSubscriptionId });
      return null;
    }
    const key = secretKeyFuer(sub.stripeModus);
    if (!key) throw new Error("Die Zahlung mit Stripe ist im Leser nicht eingerichtet.");
    const s = await stripeClient(key)("POST", `subscriptions/${stripeSubscriptionId}`, {
      cancel_at_period_end: zuruecknehmen ? "false" : "true",
    });
    // Nicht auf den Webhook warten: das Profil zeigt den Stand sofort.
    await ctx.runMutation(internal.subscriptions.upsertFromStripe, aboAusStripe(s, sub.stripeModus));
    return null;
  },
});

export const portalKonfiguration = internalQuery({
  args: { userId: v.id("users"), modus: v.union(v.literal("test"), v.literal("live")) },
  handler: async (ctx, { userId, modus }) => {
    const karte = await ctx.db
      .query("leserKarten")
      .withIndex("by_user_modus", (q) => q.eq("userId", userId).eq("modus", modus))
      .unique();
    return karte?.stripeCustomerId ?? null;
  },
});

/**
 * Stripe-Kundenportal fuer Rechnungen und Zahlungsmittel. Das Konto des
 * Ladens hat kein Standardportal; der Leser benutzt eine eigene
 * Portal-Konfiguration (an `metadata.source` erkannt, sonst angelegt).
 */
export const portal = action({
  args: { returnUrl: v.string() },
  handler: async (ctx, { returnUrl }): Promise<{ url: string }> => {
    const konfig = konfigOderFehler();
    const userId = await angemeldet(ctx);
    const kunde = await ctx.runQuery(internal.leserAbo.portalKonfiguration, {
      userId,
      modus: konfig.modus,
    });
    if (!kunde) throw new Error("Für dieses Konto gibt es noch keine Zahlungen.");
    const stripe = stripeClient(konfig.secretKey);
    const liste = await stripe("GET", "billing_portal/configurations", { active: "true", limit: 100 });
    let konfiguration = (liste?.data ?? []).find((c: any) => c.metadata?.source === ABO_HERKUNFT)?.id;
    if (!konfiguration) {
      konfiguration = (
        await stripe(
          "POST",
          "billing_portal/configurations",
          {
            business_profile: { headline: "Lesen & Schenken Digital" },
            features: {
              invoice_history: { enabled: true },
              payment_method_update: { enabled: true },
              customer_update: { enabled: true, allowed_updates: ["address", "name"] },
              subscription_cancel: { enabled: true, mode: "at_period_end" },
            },
            metadata: { source: ABO_HERKUNFT },
          },
          "leser-abo-portal-1",
        )
      ).id;
    }
    const sitzung = await stripe("POST", "billing_portal/sessions", {
      customer: kunde,
      configuration: konfiguration,
      return_url: eigeneAdresse(returnUrl, "https://digital.lesenundschenken.de/profile"),
    });
    return { url: sitzung.url };
  },
});

// --- Webhook ------------------------------------------------------------------------

/**
 * Ereignisse zum Jahresabo aus dem Webhook des Lesers (leserWebhook.ts).
 * Beachtet wird nur, was `metadata.source = "leser-abo"` traegt; der Rest des
 * Ladenkontos bleibt unberuehrt. Rueckgabe: ob das Ereignis uns gehoerte.
 */
export async function aboEreignis(
  ctx: Pick<ActionCtx, "runMutation" | "scheduler">,
  event: any,
  modus: StripeModus,
): Promise<boolean> {
  const obj = event?.data?.object ?? {};
  switch (event?.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (obj.metadata?.source !== ABO_HERKUNFT) return false;
      await ctx.runMutation(
        internal.subscriptions.upsertFromStripe,
        aboAusStripe(obj, modus, event.type === "customer.subscription.deleted"),
      );
      return true;
    }
    case "checkout.session.completed": {
      if (obj.metadata?.source !== ABO_HERKUNFT) return false;
      if (obj.payment_status !== "paid" && obj.payment_status !== "no_payment_required") return true;
      await ctx.runMutation(internal.purchases.recordPaid, {
        userId: obj.metadata?.userId || undefined,
        email: obj.customer_details?.email ?? obj.customer_email ?? "",
        planId: obj.metadata?.planId || undefined,
        stripeSessionId: String(obj.id),
        amountCents: Number(obj.amount_total ?? 0),
      });
      const email = obj.customer_details?.email ?? obj.customer_email;
      if (email) {
        await ctx.scheduler.runAfter(0, internal.email.sendSubscriptionStarted, { email });
      }
      return true;
    }
    case "invoice.payment_failed": {
      const merkmale =
        obj.parent?.subscription_details?.metadata ?? obj.subscription_details?.metadata ?? {};
      if (merkmale.source !== ABO_HERKUNFT) return false;
      if (obj.customer_email) {
        await ctx.scheduler.runAfter(0, internal.email.sendPaymentFailed, {
          email: obj.customer_email,
        });
      }
      return true;
    }
  }
  return false;
}
