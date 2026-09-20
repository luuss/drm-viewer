import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const TOKEN_TTL_DAYS = 30;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const createClaimTokenInternal = internalMutation({
  args: {
    bookId: v.id("books"),
    email: v.string(),
    stripeSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Stripe wiederholt Ereignisse. Ohne diese Pruefung entstuende je
    // Wiederholung ein weiterer, unabhaengig einloesbarer Gratis-Zugang.
    if (args.stripeSessionId) {
      const existing = await ctx.db
        .query("claimTokens")
        .withIndex("by_stripe_session", (q) =>
          q.eq("stripeSessionId", args.stripeSessionId),
        )
        .first();
      if (existing) return existing.token;
    }
    const token = randomToken();
    const now = Date.now();
    await ctx.db.insert("claimTokens", {
      token,
      bookId: args.bookId,
      email: args.email,
      stripeSessionId: args.stripeSessionId,
      expiresAt: now + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      createdAt: now,
    });
    return token;
  },
});

export const lookup = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("claimTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!row) return { status: "invalid" as const };
    if (row.claimedByUserId)
      return { status: "already_claimed" as const, email: row.email };
    if (row.expiresAt < Date.now()) return { status: "expired" as const };
    const book = await ctx.db.get(row.bookId);
    return {
      status: "valid" as const,
      email: row.email,
      book: book
        ? {
            _id: book._id,
            title: book.title,
            pageCount: book.pageCount,
            coverUrl: book.coverStorageId
              ? await ctx.storage.getUrl(book.coverStorageId)
              : null,
          }
        : null,
    };
  },
});

export const claim = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Bitte zuerst einloggen");

    const row = await ctx.db
      .query("claimTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!row) throw new Error("Ungültiger Token");
    if (row.claimedByUserId) throw new Error("Token bereits eingelöst");
    if (row.expiresAt < Date.now()) throw new Error("Token abgelaufen");

    // Der Link gehoert zur Kauf-Mailadresse. Ohne diese Bindung waere er ein
    // frei weitergebbarer Zweitzugang zum selben Heft.
    const user = await ctx.db.get(userId);
    const email = ((user as any)?.email ?? "").toLowerCase();
    if (row.email && email !== row.email.toLowerCase()) {
      throw new Error(
        `Dieser Link gehört zu ${row.email}. Bitte mit dieser Adresse anmelden.`,
      );
    }

    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", row.bookId),
      )
      .first();
    if (!existing) {
      await ctx.db.insert("entitlements", {
        userId,
        bookId: row.bookId,
        source: "claim",
        stripeSessionId: row.stripeSessionId,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(row._id, {
      claimedByUserId: userId,
      claimedAt: Date.now(),
    });
    return { bookId: row.bookId };
  },
});
