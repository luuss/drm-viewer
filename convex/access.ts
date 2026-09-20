import { QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Zugriff haengt ausschliesslich an Entitlements.
 *
 * Ein Abo liest nicht selbst frei, sondern erzeugt beim Abschluss, bei jeder
 * Verlaengerung und bei jeder neuen Ausgabe dauerhafte Freischaltungen (siehe
 * `subscriptions.ts`). Damit bleibt lesbar, was waehrend der Laufzeit
 * dazugehoerte — auch nach einer Kuendigung — und eine Abo-Luecke schaltet
 * nichts rueckwirkend frei.
 */
export async function hasIssueAccess(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  issueId: Id<"issues">,
): Promise<boolean> {
  const now = Date.now();
  const ent = await ctx.db
    .query("entitlements")
    .withIndex("by_user_issue", (q) =>
      q.eq("userId", userId).eq("issueId", issueId),
    )
    .first();
  if (!ent) return false;
  if (ent.validFrom !== undefined && ent.validFrom > now) return false;
  if (ent.validUntil !== undefined && ent.validUntil <= now) return false;
  return true;
}

export async function accessibleIssueIds(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Set<string>> {
  const now = Date.now();
  const ids = new Set<string>();
  const ents = await ctx.db
    .query("entitlements")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const e of ents) {
    if (e.validFrom !== undefined && e.validFrom > now) continue;
    if (e.validUntil !== undefined && e.validUntil <= now) continue;
    ids.add(e.issueId as string);
  }
  return ids;
}

const ACTIVE_SUB_STATES = new Set(["active", "trialing", "past_due"]);

/** Kulanz nach Periodenende, damit ein Zahlungslauf nichts abreissen laesst. */
export const SUB_GRACE_MS = Number(
  process.env.SUBSCRIPTION_GRACE_MS ?? String(3 * 24 * 60 * 60 * 1000),
);

export function subscriptionIsActive(sub: any, at = Date.now()): boolean {
  if (!ACTIVE_SUB_STATES.has(sub.status)) return false;
  if (sub.endedAt !== undefined && sub.endedAt <= at) return false;
  if (sub.currentPeriodEnd !== undefined && sub.currentPeriodEnd + SUB_GRACE_MS <= at) {
    return false;
  }
  return true;
}

export async function activeSubscriptions(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return subs.filter((s) => subscriptionIsActive(s));
}

export async function hasActiveSubscription(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  return (await activeSubscriptions(ctx, userId)).length > 0;
}
