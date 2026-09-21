import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireAdmin, audit } from "./roles";
import { assetUrl } from "./assets";
import { deliveryRegion } from "./schema";

type OfferPlan = {
  _id: Id<"subscriptionPlans">;
  name: string;
  tier: string;
  region: "inland" | "ausland" | "luftpost" | null;
  priceAmountCents: number;
  interval: "month" | "year";
};

type OfferTier = { tier: string; note: string | null; plans: OfferPlan[] };

function toOfferPlan(plan: Doc<"subscriptionPlans">): OfferPlan {
  return {
    _id: plan._id,
    name: plan.name,
    tier: plan.tier ?? plan.name,
    region: plan.region ?? null,
    priceAmountCents: plan.priceAmountCents,
    interval: plan.interval,
  };
}

/**
 * Preisstufen eines Titels nach Abo-Art gruppieren. Der Kiosk zeigt die
 * Inlandsstufe der ersten Abo-Art — bei den Verlagstiteln das
 * Normalabonnement. Alle anderen Stufen sieht der Kunde erst auf der
 * Abo-Seite. Ein Plan ohne Abo-Art bildet eine Art fuer sich.
 */
export function groupPlans(
  plans: Doc<"subscriptionPlans">[],
): { headline: OfferPlan; tiers: OfferTier[] } | null {
  const sorted = [...plans].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  if (sorted.length === 0) return null;
  const tiers: OfferTier[] = [];
  for (const plan of sorted) {
    const name = plan.tier ?? plan.name;
    let tier = tiers.find((t) => t.tier === name);
    if (!tier) {
      tier = {
        tier: name,
        note: plan.tierNote ?? plan.description ?? null,
        plans: [],
      };
      tiers.push(tier);
    }
    tier.plans.push(toOfferPlan(plan));
  }
  const first = tiers[0];
  const headline =
    first.plans.find((p) => (p.region ?? "inland") === "inland") ??
    first.plans[0];
  return { headline, tiers };
}

async function offerFor(
  ctx: QueryCtx,
  publication: Doc<"publications">,
  plans: Doc<"subscriptionPlans">[],
) {
  const grouped = groupPlans(plans.filter((p) => p.isActive));
  if (!grouped) return null;
  // Der Umschlag des juengsten veroeffentlichten Hefts steht fuer den Titel.
  const issues = await ctx.db
    .query("issues")
    .withIndex("by_publication", (q) => q.eq("publicationId", publication._id))
    .collect();
  const latest = issues
    .filter((i) => i.isPublished)
    .sort(
      (a, b) =>
        (b.publicationDate ?? b.createdAt) - (a.publicationDate ?? a.createdAt),
    )[0];
  return {
    publicationId: publication._id,
    publicationSlug: publication.slug,
    publicationName: publication.name,
    description: publication.description ?? null,
    coverUrl: latest ? await assetUrl(ctx, latest.coverAssetId) : null,
    latestIssueTitle: latest?.title ?? null,
    ...grouped,
  };
}

/**
 * Uebergang: das ausgelieferte Frontend fragt noch `list` ab und zeigt jede
 * Zeile als eigene Abo-Karte mit Zustimmungskaestchen im Kiosk. Bis das
 * Frontend mit `offers` und der Abo-Seite draussen ist, bleibt die Liste
 * leer, dann blendet der alte Kiosk seinen Abo-Block aus. Danach loeschen.
 */
export const list = query({
  args: {},
  handler: async () => [] as never[],
});

/** Kiosk: je Titel ein Abo, sofern er aktive Preisstufen hat. */
export const offers = query({
  args: {},
  handler: async (ctx) => {
    const plans = await ctx.db.query("subscriptionPlans").collect();
    const byPublication = new Map<string, Doc<"subscriptionPlans">[]>();
    for (const plan of plans) {
      if (!plan.isActive) continue;
      const own = byPublication.get(plan.publicationId) ?? [];
      own.push(plan);
      byPublication.set(plan.publicationId, own);
    }
    const publications = await ctx.db.query("publications").collect();
    publications.sort((a, b) => a.createdAt - b.createdAt);
    const out = [];
    for (const publication of publications) {
      if (!publication.isActive) continue;
      const own = byPublication.get(publication._id);
      if (!own) continue;
      const offer = await offerFor(ctx, publication, own);
      if (offer) out.push(offer);
    }
    return out;
  },
});

/** Abo-Seite eines Titels. */
export const offerBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const publication = await ctx.db
      .query("publications")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!publication || !publication.isActive) return null;
    const plans = await ctx.db
      .query("subscriptionPlans")
      .withIndex("by_publication", (q) =>
        q.eq("publicationId", publication._id),
      )
      .collect();
    return await offerFor(ctx, publication, plans);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("subscriptionPlans").collect();
  },
});

export const listByPublicationInternal = internalQuery({
  args: { publicationId: v.id("publications") },
  handler: async (ctx, { publicationId }) =>
    await ctx.db
      .query("subscriptionPlans")
      .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
      .collect(),
});

const planFields = {
  name: v.string(),
  description: v.optional(v.string()),
  publicationId: v.id("publications"),
  stripePriceId: v.string(),
  stripeProductId: v.optional(v.string()),
  priceAmountCents: v.number(),
  interval: v.union(v.literal("month"), v.literal("year")),
  tier: v.optional(v.string()),
  tierNote: v.optional(v.string()),
  region: v.optional(deliveryRegion),
  sortOrder: v.optional(v.number()),
};

export const create = mutation({
  args: planFields,
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = await ctx.db.insert("subscriptionPlans", {
      ...args,
      isActive: true,
      createdAt: Date.now(),
    });
    await audit(ctx, "plan.create", id, args.name);
    return id;
  },
});

/** Fuer das Anlegen von der Kommandozeile (`billing.seedSubscriptionPlans`). */
export const createInternal = internalMutation({
  args: planFields,
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("subscriptionPlans", {
      ...args,
      isActive: true,
      createdAt: Date.now(),
    });
    await audit(ctx, "plan.create", id, args.name);
    return id;
  },
});

export const setActive = mutation({
  args: { planId: v.id("subscriptionPlans"), isActive: v.boolean() },
  handler: async (ctx, { planId, isActive }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(planId, { isActive });
  },
});

export const get = query({
  args: { planId: v.id("subscriptionPlans") },
  handler: async (ctx, { planId }) => await ctx.db.get(planId),
});
