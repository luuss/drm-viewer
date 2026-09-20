import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hasBookAccess } from "./access";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Gleichzeitige Lesesitzungen je Konto. Bremst geteilte Zugaenge. */
const MAX_ACTIVE_SESSIONS = Number(process.env.MAX_ACTIVE_SESSIONS ?? "3");

/** Innerhalb dieser Zeit liefert `issue` dieselbe Sitzung zurueck. */
const REISSUE_COOLDOWN_MS = Number(
  process.env.SESSION_REISSUE_COOLDOWN_MS ?? String(5 * 60 * 1000),
);

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
    if (!(await hasBookAccess(ctx, userId, bookId))) {
      throw new Error("Kein Zugriff");
    }

    const now = Date.now();
    const all = await ctx.db
      .query("tileSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    for (const o of all) {
      if (o.expiresAt < now) await ctx.db.delete(o._id);
    }
    const active = all.filter((o) => o.expiresAt >= now);

    // Sitzung fuer dieselbe Ausgabe erneuern statt neue anzulegen. Wer das in
    // kurzer Folge tut, will die Kachelbremse umgehen — dann Bestand zurueckgeben.
    const sameBook = active.filter((o) => o.bookId === bookId);
    const fresh = sameBook.find(
      (o) => now - o.createdAt < REISSUE_COOLDOWN_MS,
    );
    if (fresh) {
      return { token: fresh.sessionToken, expiresAt: fresh.expiresAt };
    }
    for (const o of sameBook) await ctx.db.delete(o._id);
    const others = active.filter((o) => o.bookId !== bookId);

    if (others.length >= MAX_ACTIVE_SESSIONS) {
      // Aelteste Sitzung weicht — Konto bleibt nutzbar, Massenteilung nicht.
      others.sort((a, b) => a.createdAt - b.createdAt);
      const drop = others.slice(0, others.length - MAX_ACTIVE_SESSIONS + 1);
      for (const d of drop) await ctx.db.delete(d._id);
    }

    const token = randomToken();
    await ctx.db.insert("tileSessions", {
      userId,
      sessionToken: token,
      bookId,
      createdAt: now,
      lastSeenAt: now,
      tileCount: 0,
      expiresAt: now + SESSION_TTL_MS,
    });
    return { token, expiresAt: now + SESSION_TTL_MS };
  },
});

export const verify = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
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
      sessionId: row._id,
    };
  },
});

/** Der Kacheldienst meldet Verbrauch zurueck: Grundlage fuer Missbrauchserkennung. */
export const reportUsage = internalMutation({
  args: { sessionToken: v.string(), tiles: v.number() },
  handler: async (ctx, { sessionToken, tiles }) => {
    const row = await ctx.db
      .query("tileSessions")
      .withIndex("by_token", (q) => q.eq("sessionToken", sessionToken))
      .unique();
    if (!row) return { ok: false };
    await ctx.db.patch(row._id, {
      tileCount: (row.tileCount ?? 0) + tiles,
      lastSeenAt: Date.now(),
    });
    return { ok: true };
  },
});

export const myActiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query("tileSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.expiresAt >= now)
        .map(async (r) => ({
          _id: r._id,
          bookTitle: (await ctx.db.get(r.bookId))?.title ?? "",
          createdAt: r.createdAt,
          lastSeenAt: r.lastSeenAt ?? r.createdAt,
          tileCount: r.tileCount ?? 0,
        })),
    );
  },
});

export const revokeAllMySessions = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht eingeloggt");
    const rows = await ctx.db
      .query("tileSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
