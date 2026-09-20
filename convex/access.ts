import { QueryCtx, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

const ACTIVE_SUB_STATES = new Set(["active", "trialing", "past_due"]);

/** Abo-Kulanz: nach Periodenende bleibt der Zugriff kurz offen (Zahlungslauf). */
const SUB_GRACE_MS = 1000 * 60 * 60 * 24 * 3;

export async function hasActiveSubscription(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const now = Date.now();
  return subs.some(
    (s) =>
      ACTIVE_SUB_STATES.has(s.status) &&
      (s.currentPeriodEnd === undefined ||
        s.currentPeriodEnd + SUB_GRACE_MS > now),
  );
}

export async function hasBookAccess(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  bookId: Id<"books">,
): Promise<boolean> {
  const now = Date.now();
  const ent = await ctx.db
    .query("entitlements")
    .withIndex("by_user_book", (q) =>
      q.eq("userId", userId).eq("bookId", bookId),
    )
    .first();
  if (ent && (ent.validUntil === undefined || ent.validUntil > now)) return true;

  const book = await ctx.db.get(bookId);
  if (!book) return false;
  if (book.includedInSubscription === false) return false;

  return await hasActiveSubscription(ctx, userId);
}
