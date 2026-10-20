import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  MutationCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { subscriptionIsActive, SUB_GRACE_MS } from "./access";
import { Id } from "./_generated/dataModel";

/**
 * Welche Ausgaben ein Abo freischaltet.
 *
 * Regel: alles, was waehrend der Laufzeit erscheint, plus das zum
 * Abschlusszeitpunkt aktuelle Heft — auch wenn es davor erschienen ist. Nach
 * einer Pause bleibt die Luecke zu; beim Neustart gibt es wieder das dann
 * aktuelle Heft. Die Freischaltung ist dauerhaft und wird nie entzogen.
 */
export async function issuesCoveredBySubscription(
  ctx: MutationCtx,
  sub: any,
): Promise<Id<"issues">[]> {
  if (!sub.publicationId) return [];
  const now = Date.now();
  const until = Math.min(
    now,
    sub.endedAt ??
      (sub.currentPeriodEnd !== undefined
        ? sub.currentPeriodEnd + SUB_GRACE_MS
        : now),
  );

  const published = await ctx.db
    .query("issues")
    .withIndex("by_published", (q) => q.eq("isPublished", true))
    .collect();
  const ofPublication = published.filter(
    (i) => i.publicationId === sub.publicationId && i.includedInSubscription,
  );

  const covered: Id<"issues">[] = [];
  for (const issue of ofPublication) {
    const at = issue.publishedAt ?? issue.publicationDate ?? issue.createdAt;
    if (at >= sub.startedAt && at <= until) covered.push(issue._id);
  }

  // Das zum Abschluss aktuelle Heft gehoert dazu, auch wenn es aelter ist.
  const beforeStart = ofPublication
    .filter((i) => (i.publishedAt ?? i.createdAt) < sub.startedAt)
    .sort(
      (a, b) => (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt),
    );
  if (beforeStart.length > 0 && !covered.includes(beforeStart[0]._id)) {
    covered.push(beforeStart[0]._id);
  }
  return covered;
}

/** Idempotent: legt fehlende Freischaltungen an, entzieht nie etwas. */
export async function syncSubscription(
  ctx: MutationCtx,
  subId: Id<"subscriptions">,
): Promise<number> {
  const sub = await ctx.db.get(subId);
  if (!sub) return 0;
  const covered = await issuesCoveredBySubscription(ctx, sub);
  let granted = 0;
  for (const issueId of covered) {
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", sub.userId).eq("issueId", issueId),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("entitlements", {
      userId: sub.userId,
      issueId,
      source: "subscription",
      subscriptionId: subId,
      createdAt: Date.now(),
    });
    granted++;
  }
  await ctx.db.patch(subId, { lastSyncedAt: Date.now() });
  if (granted > 0) {
    console.log(
      JSON.stringify({
        event: "subscription.sync",
        subscriptionId: subId,
        granted,
      }),
    );
  }
  return granted;
}

export const upsertFromStripe = internalMutation({
  args: {
    userId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    status: v.string(),
    startedAt: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    endedAt: v.optional(v.number()),
    publicationId: v.optional(v.id("publications")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_stripe_subscription", (q) =>
        q.eq("stripeSubscriptionId", args.stripeSubscriptionId),
      )
      .unique();

    const userId = (args.userId ?? existing?.userId) as Id<"users"> | undefined;
    if (!userId) {
      console.warn(
        `Abo ${args.stripeSubscriptionId} ohne Konto — keine Zuordnung moeglich`,
      );
      return null;
    }

    // Plan bestimmt die Publikation, falls der Webhook sie nicht mitliefert.
    let publicationId = args.publicationId ?? existing?.publicationId;
    if (!publicationId && args.stripePriceId) {
      const plan = await ctx.db
        .query("subscriptionPlans")
        .withIndex("by_stripe_price", (q) =>
          q.eq("stripePriceId", args.stripePriceId!),
        )
        .first();
      publicationId = plan?.publicationId;
    }

    const wasInactive = existing ? !subscriptionIsActive(existing) : true;
    const doc = {
      userId,
      stripeCustomerId: args.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId,
      publicationId,
      status: args.status,
      // Nach einer Pause zaehlt der neue Start, damit die Luecke zubleibt.
      startedAt:
        existing && !wasInactive
          ? existing.startedAt
          : (args.startedAt ?? Date.now()),
      currentPeriodEnd: args.currentPeriodEnd,
      cancelAtPeriodEnd: args.cancelAtPeriodEnd,
      endedAt: args.endedAt,
      updatedAt: Date.now(),
    };

    const subId = existing
      ? (await ctx.db.patch(existing._id, doc), existing._id)
      : await ctx.db.insert("subscriptions", doc);

    if (subscriptionIsActive({ ...doc })) {
      await syncSubscription(ctx, subId);
    }
    return subId;
  },
});

/** Neue Ausgabe erschienen: alle laufenden Abos der Publikation nachziehen. */
export const syncForIssueInternal = internalMutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue?.isPublished || !issue.includedInSubscription) return 0;
    const subs = await ctx.db.query("subscriptions").collect();
    let granted = 0;
    for (const sub of subs) {
      if (sub.publicationId !== issue.publicationId) continue;
      if (!subscriptionIsActive(sub)) continue;
      granted += await syncSubscription(ctx, sub._id);
    }
    return granted;
  },
});

/** Taeglicher Abgleich, falls ein Webhook verloren ging. */
export const syncAllInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const subs = await ctx.db.query("subscriptions").collect();
    let granted = 0;
    for (const sub of subs) {
      if (!subscriptionIsActive(sub)) continue;
      granted += await syncSubscription(ctx, sub._id);
    }
    return granted;
  },
});

export const myStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { active: false, subscriptions: [] as any[] };
    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .collect();
    return {
      active: subs.some((s) => subscriptionIsActive(s)),
      subscriptions: await Promise.all(
        subs.map(async (s) => ({
          _id: s._id,
          stripeSubscriptionId: s.stripeSubscriptionId,
          status: s.status,
          publication: s.publicationId
            ? (await ctx.db.get(s.publicationId))?.name ?? null
            : null,
          startedAt: s.startedAt,
          currentPeriodEnd: s.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
          isActive: subscriptionIsActive(s),
        })),
      ),
    };
  },
});

export const isOwnedByInternal = internalQuery({
  args: { userId: v.id("users"), stripeSubscriptionId: v.string() },
  handler: async (ctx, { userId, stripeSubscriptionId }) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_stripe_subscription", (q) =>
        q.eq("stripeSubscriptionId", stripeSubscriptionId),
      )
      .unique();
    return sub?.userId === userId;
  },
});

export const findUserByCustomerInternal = internalQuery({
  args: { stripeCustomerId: v.string() },
  handler: async (ctx, { stripeCustomerId }) => {
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_stripe_customer", (q) =>
        q.eq("stripeCustomerId", stripeCustomerId),
      )
      .first();
    return sub?.userId ?? null;
  },
});
