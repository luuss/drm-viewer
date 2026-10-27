import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  ActionCtx,
  QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail, shopSubscriptionIsActive, subscriptionIsActive } from "./access";
import { reihenDesAbos } from "./subscriptions";
import { audit, requireAdmin } from "./roles";
import { WITHDRAWAL_WAIVER_TEXT, WITHDRAWAL_WAIVER_VERSION } from "./consents";
import { StripeKonfig, StripeModus, secretKeyFuer, stripeKonfig } from "./leserStripe";
import { StripeAufruf, stripeClient } from "./stripeRest";
import { deliveryRegion } from "./schema";
import {
  DeliveryRegion,
  PlanVariant,
  SUBSCRIPTION_CATALOG,
  catalogVariants,
  kombiRegel,
  kombisMit,
} from "./subscriptionCatalog";

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
  const haupt = s.metadata?.publicationId || undefined;
  // Beim gemeinsamen Kombi-Abo traegt jeder Posten die Reihe seines Preises.
  const weitere = [
    ...new Set<string>(
      [
        ...(s?.items?.data ?? []).map((x: any) => x?.price?.metadata?.publicationId),
        ...String(s.metadata?.weitereReihen ?? "").split(","),
      ].filter((id: any) => id && id !== haupt),
    ),
  ];
  const kombi = s.metadata?.kombi;
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
    publicationId: haupt,
    weitereReihen: weitere.length > 0 ? (weitere as Id<"publications">[]) : undefined,
    kombi: kombi === "zusammen" || kombi === "vorhanden" || kombi === "entfallen" ? kombi : undefined,
    stripeModus: modus,
  };
}

// --- Kombi-Abo ------------------------------------------------------------------

/** Laufendes Abo der Reihe, im Leser oder als Digital-Abo aus dem Netzladen? */
export async function hatLaufendesAbo(
  ctx: QueryCtx,
  userId: Id<"users">,
  publicationId: Id<"publications">,
): Promise<boolean> {
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  if (subs.some((s) => subscriptionIsActive(s) && reihenDesAbos(s).includes(publicationId))) {
    return true;
  }
  const email = normalizeEmail((await ctx.db.get(userId))?.email);
  if (!email) return false;
  const zeilen = await ctx.db
    .query("shopAccess")
    .withIndex("by_email_publication", (q) => q.eq("email", email).eq("publicationId", publicationId))
    .take(200);
  return zeilen.some((z) => shopSubscriptionIsActive(z));
}

/**
 * Lage einer Kombi-Stufe: Partnerreihe, deren Stufe im selben Gebiet (fuer
 * den gemeinsamen Abschluss) und ob das Konto dort schon ein Abo hat.
 * `null`, wenn die Stufe keine Kombi ist.
 */
async function kombiLage(ctx: QueryCtx, plan: Doc<"subscriptionPlans">, userId: Id<"users"> | null) {
  const reihe = await ctx.db.get(plan.publicationId);
  const regel = reihe ? kombiRegel(reihe.slug, plan.tier) : null;
  if (!regel) return null;
  const partner = await ctx.db
    .query("publications")
    .withIndex("by_slug", (q) => q.eq("slug", regel.mit))
    .unique();
  if (!partner?.isActive) return { regel, partner: null, partnerPlan: null, vorhanden: false };
  const partnerPlan =
    (
      await ctx.db
        .query("subscriptionPlans")
        .withIndex("by_publication", (q) => q.eq("publicationId", partner._id))
        .collect()
    ).find(
      (p) =>
        p.isActive &&
        p.stripeModus === plan.stripeModus &&
        (p.tier ?? p.name) === regel.mitStufe &&
        p.region === plan.region,
    ) ?? null;
  const vorhanden = userId ? await hatLaufendesAbo(ctx, userId, partner._id) : false;
  return { regel, partner, partnerPlan, vorhanden };
}

/**
 * Kombi-Angaben fuer die Abo-Seite: je Kombi-Stufe der Reihe die Partnerreihe,
 * der Preis beider zusammen und ob das Konto dort schon ein Abo hat; dazu die
 * Kombi-Abos anderer Reihen, die diese Reihe einschliessen.
 */
export const kombiAngebot = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const reihe = await ctx.db
      .query("publications")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    const modus = stripeKonfig()?.modus;
    if (!reihe || !modus) return { stufen: [], alsPartner: [] };
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    const plaene = (
      await ctx.db
        .query("subscriptionPlans")
        .withIndex("by_publication", (q) => q.eq("publicationId", reihe._id))
        .collect()
    ).filter((p) => p.isActive && p.stripeModus === modus);
    const stufen = [];
    for (const plan of plaene) {
      const lage = await kombiLage(ctx, plan, userId);
      if (!lage?.partner) continue;
      stufen.push({
        planId: plan._id,
        partnerName: lage.partner.name,
        partnerSlug: lage.partner.slug,
        partnerStufe: lage.partnerPlan?.name ?? null,
        zusammenCents: lage.partnerPlan ? plan.priceAmountCents + lage.partnerPlan.priceAmountCents : null,
        vorhanden: lage.vorhanden,
      });
    }
    const alsPartner = [];
    for (const k of kombisMit(slug)) {
      const andere = await ctx.db
        .query("publications")
        .withIndex("by_slug", (q) => q.eq("slug", k.reihe))
        .unique();
      if (!andere?.isActive) continue;
      const kombiPlaene = (
        await ctx.db
          .query("subscriptionPlans")
          .withIndex("by_publication", (q) => q.eq("publicationId", andere._id))
          .collect()
      ).filter((p) => p.isActive && p.stripeModus === modus && p.tier === k.tier);
      if (kombiPlaene.length === 0) continue;
      alsPartner.push({ reiheName: andere.name, reiheSlug: andere.slug, tier: k.tier });
    }
    return { stufen, alsPartner };
  },
});

// --- Preise anlegen (Redaktion) -------------------------------------------------

/**
 * Eine Preisstufe ist Abo-Art mal Liefergebiet, wie im Katalog
 * (subscriptionCatalog.ts). Der fruehere Einzelpreis "Jahresabo" hat kein
 * Gebiet und wird von der ersten Katalogstufe abgeloest.
 */
const EINZELPREIS = "Jahresabo";

const stufe = { tier: v.string(), region: v.optional(deliveryRegion) };

function gleicheStufe(p: Doc<"subscriptionPlans">, tier: string, region: DeliveryRegion | undefined) {
  return (p.tier ?? p.name) === tier && p.region === region;
}

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
    const katalog = SUBSCRIPTION_CATALOG[publication.slug];
    return {
      name: publication.name,
      // Das Produkt bleibt bei einem neuen Preis dasselbe.
      productId: eigene.find((p) => p.stripeProductId)?.stripeProductId ?? null,
      varianten: katalog ? catalogVariants(katalog) : [],
      aktiv: eigene
        .filter((p) => p.isActive)
        .map((p) => ({ tier: p.tier ?? p.name, region: p.region })),
    };
  },
});

/** Neuer Preis einer Stufe wird der aktive; der fruehere dieser Stufe geht aus dem Verkauf. */
export const planSetzen = internalMutation({
  args: {
    publicationId: v.id("publications"),
    modus: v.union(v.literal("test"), v.literal("live")),
    ...stufe,
    tierNote: v.optional(v.string()),
    name: v.string(),
    sortOrder: v.number(),
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
      if (!p.isActive || p.stripeModus !== a.modus) continue;
      if (gleicheStufe(p, a.tier, a.region) || gleicheStufe(p, EINZELPREIS, undefined)) {
        await ctx.db.patch(p._id, { isActive: false });
      }
    }
    const id = await ctx.db.insert("subscriptionPlans", {
      name: a.name,
      tier: a.tier,
      tierNote: a.tierNote,
      region: a.region,
      publicationId: a.publicationId,
      stripePriceId: a.stripePriceId,
      stripeProductId: a.stripeProductId,
      stripeTaxRateId: a.stripeTaxRateId,
      stripeModus: a.modus,
      priceAmountCents: a.priceAmountCents,
      interval: "year",
      isActive: true,
      sortOrder: a.sortOrder,
      createdAt: Date.now(),
    });
    await audit(ctx, "abo.preis", a.publicationId, `${a.name}: ${a.priceAmountCents} Cent (${a.modus})`);
    return id;
  },
});

/** Eine Stufe aus dem Verkauf nehmen; laufende Abos laufen weiter. */
export const stufeBeenden = internalMutation({
  args: {
    publicationId: v.id("publications"),
    modus: v.union(v.literal("test"), v.literal("live")),
    ...stufe,
  },
  handler: async (ctx, { publicationId, modus, tier, region }) => {
    await requireAdmin(ctx);
    const plaene = await ctx.db
      .query("subscriptionPlans")
      .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
      .collect();
    for (const p of plaene) {
      if (p.isActive && p.stripeModus === modus && gleicheStufe(p, tier, region)) {
        await ctx.db.patch(p._id, { isActive: false });
      }
    }
    await audit(ctx, "abo.verkaufBeendet", publicationId, `${tier} ${region ?? ""} (${modus})`.trim());
  },
});

/** Stufen einer Reihe fuer die Einstellungen: Katalog und was davon im Verkauf ist. */
export const stufen = query({
  args: { publicationId: v.id("publications") },
  handler: async (ctx, { publicationId }) => {
    await requireAdmin(ctx);
    const publication = await ctx.db.get(publicationId);
    if (!publication) return [];
    const modus = stripeKonfig()?.modus ?? null;
    const aktiv = (
      await ctx.db
        .query("subscriptionPlans")
        .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
        .collect()
    ).filter((p) => p.isActive && p.stripeModus && p.stripeModus === modus);
    const katalog = SUBSCRIPTION_CATALOG[publication.slug];
    const zeilen = (katalog ? catalogVariants(katalog) : []).map((variante) => ({
      tier: variante.tier,
      region: variante.region as DeliveryRegion | undefined,
      name: variante.name,
      katalogCents: variante.priceAmountCents as number | null,
      imVerkauf: aktiv.find((p) => gleicheStufe(p, variante.tier, variante.region))?.priceAmountCents ?? null,
    }));
    // Was nicht im Katalog steht (etwa der fruehere Einzelpreis), nur zum Herausnehmen.
    for (const p of aktiv) {
      if (zeilen.some((z) => gleicheStufe(p, z.tier, z.region))) continue;
      zeilen.push({
        tier: p.tier ?? p.name,
        region: p.region,
        name: p.name,
        katalogCents: null,
        imVerkauf: p.priceAmountCents,
      });
    }
    return zeilen;
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

/** Legt bei Stripe den Jahrespreis einer Stufe an (Produkt einmal je Reihe) und setzt ihn aktiv. */
async function stufePreisAnlegen(
  ctx: ActionCtx,
  konfig: StripeKonfig,
  publicationId: Id<"publications">,
  variante: PlanVariant,
  priceAmountCents: number,
): Promise<void> {
  if (!Number.isInteger(priceAmountCents) || priceAmountCents < 100 || priceAmountCents > 100_000) {
    throw new Error("Preis in Cent zwischen 1 € und 1000 €");
  }
  // Prueft auch die Rolle.
  const reihe = await ctx.runQuery(internal.leserAbo.reiheFuerPreis, { publicationId, modus: konfig.modus });
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
      nickname: variante.name,
      metadata: { source: ABO_HERKUNFT, publicationId, tier: variante.tier, region: variante.region },
    },
    `leser-abo-preis-${publicationId}-${konfig.modus}-${variante.sortOrder}-${priceAmountCents}`,
  );
  await ctx.runMutation(internal.leserAbo.planSetzen, {
    publicationId,
    modus: konfig.modus,
    tier: variante.tier,
    tierNote: variante.tierNote,
    region: variante.region,
    name: variante.name,
    sortOrder: variante.sortOrder,
    priceAmountCents,
    stripePriceId: preis.id,
    stripeProductId: productId,
    stripeTaxRateId: await steuersatz(stripe),
  });
}

/**
 * Preis einer Stufe setzen (Redaktion → Einstellungen). Ein neuer Preis gilt
 * fuer neue Abschluesse; laufende Abos behalten ihren.
 * `priceAmountCents: null` nimmt die Stufe aus dem Verkauf.
 */
export const preisSetzen = action({
  args: {
    publicationId: v.id("publications"),
    ...stufe,
    priceAmountCents: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { publicationId, tier, region, priceAmountCents }): Promise<null> => {
    const konfig = konfigOderFehler();
    if (priceAmountCents === null) {
      await ctx.runMutation(internal.leserAbo.stufeBeenden, { publicationId, modus: konfig.modus, tier, region });
      return null;
    }
    const reihe = await ctx.runQuery(internal.leserAbo.reiheFuerPreis, { publicationId, modus: konfig.modus });
    const variante = reihe.varianten.find((x) => x.tier === tier && x.region === region);
    if (!variante) throw new Error("Diese Stufe steht nicht im Abo-Katalog der Reihe.");
    await stufePreisAnlegen(ctx, konfig, publicationId, variante, priceAmountCents);
    return null;
  },
});

/** Alle Katalogstufen der Reihe, die noch nicht im Verkauf sind, zum Katalogpreis anlegen. */
export const katalogUebernehmen = action({
  args: { publicationId: v.id("publications") },
  handler: async (ctx, { publicationId }): Promise<{ angelegt: number }> => {
    const konfig = konfigOderFehler();
    const reihe = await ctx.runQuery(internal.leserAbo.reiheFuerPreis, { publicationId, modus: konfig.modus });
    let angelegt = 0;
    for (const variante of reihe.varianten) {
      if (reihe.aktiv.some((a) => a.tier === variante.tier && a.region === variante.region)) continue;
      await stufePreisAnlegen(ctx, konfig, publicationId, variante, variante.priceAmountCents);
      angelegt++;
    }
    return { angelegt };
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
    const lage = await kombiLage(ctx, plan, userId);
    return {
      email,
      plan: plan as Doc<"subscriptionPlans">,
      reihe: publication.name,
      slug: publication.slug,
      stripeCustomerId: karte?.stripeCustomerId ?? null,
      kombi: lage
        ? {
            partnerId: lage.partner?._id ?? null,
            partnerName: lage.partner?.name ?? lage.regel.mit,
            partnerPreis: lage.partnerPlan
              ? { priceId: lage.partnerPlan.stripePriceId, taxRateId: lage.partnerPlan.stripeTaxRateId ?? null }
              : null,
            vorhanden: lage.vorhanden,
          }
        : null,
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
    const posten: Record<string, unknown>[] = [
      { price: vb.plan.stripePriceId, quantity: 1, tax_rates: [vb.plan.stripeTaxRateId] },
    ];
    const kombiMerkmale: Record<string, string> = {};
    let beschreibung = `${vb.reihe} Digital-Jahresabo, ${vb.plan.name}`;
    // Kombi: mit laufendem Abo der Partnerreihe nur die eigene Stufe zum
    // Kombipreis, sonst beide Reihen zusammen in einem Abo.
    if (vb.kombi) {
      const { partnerId, partnerName, partnerPreis, vorhanden } = vb.kombi;
      if (vorhanden) {
        kombiMerkmale.kombi = "vorhanden";
      } else {
        if (!partnerId || !partnerPreis?.taxRateId) {
          throw new Error(`Das Kombi-Abo zusammen mit ${partnerName} gibt es in diesem Liefergebiet nicht.`);
        }
        posten.push({ price: partnerPreis.priceId, quantity: 1, tax_rates: [partnerPreis.taxRateId] });
        kombiMerkmale.kombi = "zusammen";
        kombiMerkmale.weitereReihen = partnerId;
        beschreibung = `${vb.reihe} und ${partnerName} Digital-Jahresabo, ${vb.plan.name}`;
      }
    }
    const stripe = stripeClient(konfig.secretKey);
    const kunde = await kundeFuer(ctx, stripe, konfig, userId, vb.email, vb.stripeCustomerId);
    const merkmale = {
      source: ABO_HERKUNFT,
      planId: args.planId,
      userId,
      publicationId: vb.plan.publicationId,
      ...kombiMerkmale,
    };
    const sitzung = await stripe("POST", "checkout/sessions", {
      mode: "subscription",
      customer: kunde,
      line_items: posten,
      success_url: eigeneAdresse(args.successUrl, "https://digital.lesenundschenken.de/library?abo=1"),
      cancel_url: eigeneAdresse(args.cancelUrl, `https://digital.lesenundschenken.de/abo/${vb.slug}`),
      locale: "de",
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      metadata: merkmale,
      subscription_data: {
        description: beschreibung,
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

// --- Kombi ohne Partnerabo -----------------------------------------------------------

/** Tage vor der Verlaengerung, ab denen ein Kombi-Abo ohne Partnerabo umgestellt wird. */
const KOMBI_VORLAUF_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Kombi-Abos "vorhanden", die bald verlaengern, obwohl das Konto kein Abo der
 * Partnerreihe mehr hat, mit dem Preis, zu dem sie weiterlaufen.
 */
export const kombiFaellig = internalQuery({
  args: { modus: v.union(v.literal("test"), v.literal("live")) },
  handler: async (ctx, { modus }) => {
    const jetzt = Date.now();
    const out: { stripeSubscriptionId: string; preisId: string; steuerId: string; name: string }[] = [];
    for (const sub of await ctx.db.query("subscriptions").collect()) {
      if (sub.kombi !== "vorhanden" || sub.stripeModus !== modus || sub.cancelAtPeriodEnd) continue;
      if (!subscriptionIsActive(sub) || sub.currentPeriodEnd === undefined) continue;
      if (sub.currentPeriodEnd - jetzt > KOMBI_VORLAUF_MS) continue;
      const plan = sub.stripePriceId
        ? await ctx.db
            .query("subscriptionPlans")
            .withIndex("by_stripe_price", (q) => q.eq("stripePriceId", sub.stripePriceId!))
            .first()
        : null;
      if (!plan) continue;
      const lage = await kombiLage(ctx, plan, sub.userId);
      if (!lage || lage.vorhanden) continue;
      const sonst = (
        await ctx.db
          .query("subscriptionPlans")
          .withIndex("by_publication", (q) => q.eq("publicationId", plan.publicationId))
          .collect()
      ).find(
        (p) =>
          p.isActive &&
          p.stripeModus === modus &&
          (p.tier ?? p.name) === lage.regel.sonst &&
          p.region === plan.region &&
          p.stripeTaxRateId,
      );
      if (!sonst) {
        console.warn(`Kombi-Abo ${sub.stripeSubscriptionId}: keine Stufe ${lage.regel.sonst} im Verkauf`);
        continue;
      }
      out.push({
        stripeSubscriptionId: sub.stripeSubscriptionId,
        preisId: sonst.stripePriceId,
        steuerId: sonst.stripeTaxRateId!,
        name: sonst.name,
      });
    }
    return out;
  },
});

/**
 * Taeglich: Kombi-Abos ohne Partnerabo verlaengern zum Preis der Stufe
 * `sonst` (AGB § 7). Ohne anteilige Verrechnung; der neue Preis gilt ab der
 * naechsten Laufzeit.
 */
export const kombiPruefen = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const konfig = stripeKonfig();
    if (!konfig) return 0;
    const faellig = await ctx.runQuery(internal.leserAbo.kombiFaellig, { modus: konfig.modus });
    const stripe = stripeClient(konfig.secretKey);
    for (const f of faellig) {
      const s = await stripe("GET", `subscriptions/${f.stripeSubscriptionId}`, {});
      const posten = s?.items?.data?.[0];
      if (!posten) continue;
      const neu = await stripe("POST", `subscriptions/${f.stripeSubscriptionId}`, {
        items: [{ id: posten.id, price: f.preisId, tax_rates: [f.steuerId] }],
        proration_behavior: "none",
        metadata: { kombi: "entfallen" },
      });
      await ctx.runMutation(internal.subscriptions.upsertFromStripe, aboAusStripe(neu, konfig.modus));
      console.log(JSON.stringify({ event: "abo.kombiEntfallen", abo: f.stripeSubscriptionId, neu: f.name }));
    }
    return faellig.length;
  },
});
