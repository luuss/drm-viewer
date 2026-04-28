import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const issue = mutation({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const ent = await ctx.db
      .query("entitlements")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .first();
    if (!ent) throw new Error("Kein Zugriff");

    const now = Date.now();
    const old = await ctx.db
      .query("tileSessions")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .collect();
    for (const o of old) {
      if (o.expiresAt < now) await ctx.db.delete(o._id);
    }

    const token = randomToken();
    await ctx.db.insert("tileSessions", {
      userId,
      sessionToken: token,
      bookId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    return { token, expiresAt: now + SESSION_TTL_MS };
  },
});

export const verify = query({
  args: { sessionToken: v.string(), serviceSecret: v.string() },
  handler: async (ctx, { sessionToken, serviceSecret }) => {
    if (serviceSecret !== process.env.TILE_SERVICE_SECRET) {
      return { ok: false, reason: "bad_secret" as const };
    }
    const row = await ctx.db
      .query("tileSessions")
      .withIndex("by_token", (q) => q.eq("sessionToken", sessionToken))
      .unique();
    if (!row) return { ok: false, reason: "not_found" as const };
    if (row.expiresAt < Date.now())
      return { ok: false, reason: "expired" as const };
    return {
      ok: true as const,
      userId: row.userId,
      bookId: row.bookId,
    };
  },
});
