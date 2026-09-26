import { QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Zugriff haengt an zwei Quellen.
 *
 * 1. Entitlements. Ein Stripe-Abo liest nicht selbst frei, sondern erzeugt
 *    beim Abschluss, bei jeder Verlaengerung und bei jeder neuen Ausgabe
 *    dauerhafte Freischaltungen (siehe `subscriptions.ts`). Damit bleibt
 *    lesbar, was waehrend der Laufzeit dazugehoerte — auch nach einer
 *    Kuendigung — und eine Abo-Luecke schaltet nichts rueckwirkend frei.
 * 2. Kaeufe im Laden (`shopAccess`), ueber die E-Mail-Adresse des Kontos.
 *    Ein Heft gilt unbefristet, ein Digital-Abo alle veroeffentlichten
 *    Abo-Ausgaben der Reihe bis zum Ablaufdatum. Nach Ablauf ist die Reihe
 *    wieder zu — anders als beim Stripe-Abo bleibt nichts dauerhaft.
 */
export async function hasIssueAccess(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  issueId: Id<"issues">,
): Promise<boolean> {
  const now = Date.now();
  // Alle Zeilen pruefen: neben einer abgelaufenen Freischaltung kann eine
  // gueltige liegen.
  const ents = await ctx.db
    .query("entitlements")
    .withIndex("by_user_issue", (q) =>
      q.eq("userId", userId).eq("issueId", issueId),
    )
    .take(20);
  for (const ent of ents) {
    if (ent.validFrom !== undefined && ent.validFrom > now) continue;
    if (ent.validUntil !== undefined && ent.validUntil <= now) continue;
    return true;
  }
  return await hasShopAccess(ctx, userId, issueId, now);
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

  const email = await emailOfUser(ctx, userId);
  if (!email) return ids;
  const rows = await ctx.db
    .query("shopAccess")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(1000);
  const publications = new Set<Id<"publications">>();
  for (const row of rows) {
    if (row.revokedAt !== undefined) continue;
    if (row.kind === "issue" && row.issueId) ids.add(row.issueId as string);
    if (row.publicationId && shopSubscriptionIsActive(row, now)) {
      publications.add(row.publicationId);
    }
  }
  for (const publicationId of publications) {
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
      .take(2000);
    for (const issue of issues) {
      if (coveredByShopSubscription(issue)) ids.add(issue._id as string);
    }
  }
  return ids;
}

// --- Kaeufe im Laden ------------------------------------------------------

/** Adressen werden ueberall klein und ohne Leerraum verglichen. */
export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

async function emailOfUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const user = await ctx.db.get(userId);
  return normalizeEmail(user?.email);
}

/** Digital-Abo aus dem Laden: nicht widerrufen und im Zeitraum. */
export function shopSubscriptionIsActive(
  row: {
    kind: string;
    revokedAt?: number;
    validFrom?: number;
    validUntil?: number;
  },
  at = Date.now(),
): boolean {
  if (row.kind !== "subscription" || row.revokedAt !== undefined) return false;
  if (row.validFrom === undefined || row.validUntil === undefined) return false;
  return row.validFrom <= at && at < row.validUntil;
}

/**
 * Was ein Digital-Abo abdeckt: veroeffentlichte Ausgaben der Reihe, die die
 * Redaktion nicht vom Abo ausgenommen hat — dieselbe Schranke wie beim
 * Stripe-Abo.
 */
function coveredByShopSubscription(issue: {
  isPublished: boolean;
  includedInSubscription: boolean;
}): boolean {
  return issue.isPublished && issue.includedInSubscription;
}

async function hasShopAccess(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  issueId: Id<"issues">,
  now: number,
): Promise<boolean> {
  const email = await emailOfUser(ctx, userId);
  if (!email) return false;

  const single = await ctx.db
    .query("shopAccess")
    .withIndex("by_email_issue", (q) =>
      q.eq("email", email).eq("issueId", issueId),
    )
    .take(20);
  if (single.some((row) => row.revokedAt === undefined)) return true;

  const issue = await ctx.db.get(issueId);
  if (!issue || !coveredByShopSubscription(issue)) return false;
  const subs = await ctx.db
    .query("shopAccess")
    .withIndex("by_email_publication", (q) =>
      q.eq("email", email).eq("publicationId", issue.publicationId),
    )
    .take(200);
  return subs.some((row) => shopSubscriptionIsActive(row, now));
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
