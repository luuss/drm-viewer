import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hasIssueAccess } from "./access";
import { Id } from "./_generated/dataModel";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Gleichzeitige Lesesitzungen je Konto. Bremst geteilte Zugaenge. */
const MAX_ACTIVE_SESSIONS = Number(process.env.MAX_ACTIVE_SESSIONS ?? "2");

/** Innerhalb dieser Zeit wird dieselbe Sitzung zurueckgegeben. */
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
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht angemeldet");
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) {
      throw new Error("Kein Zugriff auf diese Ausgabe");
    }

    const now = Date.now();
    const all = await ctx.db
      .query("readerSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .collect();
    for (const o of all) {
      if (o.expiresAt < now) await ctx.db.delete(o._id);
    }
    const active = all.filter((o) => o.expiresAt >= now);

    const sameIssue = active.filter((o) => o.issueId === issueId);
    const fresh = sameIssue.find((o) => now - o.createdAt < REISSUE_COOLDOWN_MS);
    if (fresh) {
      return { token: fresh.sessionToken, expiresAt: fresh.expiresAt };
    }
    for (const o of sameIssue) await ctx.db.delete(o._id);

    const others = active.filter((o) => o.issueId !== issueId);
    if (others.length >= MAX_ACTIVE_SESSIONS) {
      // Die aelteste Sitzung weicht: das Konto bleibt nutzbar, das Weitergeben
      // an mehrere Leser aber nicht.
      others.sort((a, b) => a.createdAt - b.createdAt);
      for (const d of others.slice(0, others.length - MAX_ACTIVE_SESSIONS + 1)) {
        await ctx.db.delete(d._id);
        console.log(
          JSON.stringify({
            event: "readerSession.evicted",
            userId,
            issueId: d.issueId,
            reason: "limit",
          }),
        );
      }
    }

    const token = randomToken();
    await ctx.db.insert("readerSessions", {
      userId: userId as Id<"users">,
      sessionToken: token,
      issueId,
      createdAt: now,
      lastSeenAt: now,
      tileCount: 0,
      expiresAt: now + SESSION_TTL_MS,
    });
    return { token, expiresAt: now + SESSION_TTL_MS };
  },
});

export const verifyInternal = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const row = await ctx.db
      .query("readerSessions")
      .withIndex("by_token", (q) => q.eq("sessionToken", sessionToken))
      .unique();
    if (!row) return { ok: false, reason: "not_found" as const };
    if (row.expiresAt < Date.now()) return { ok: false, reason: "expired" as const };
    const user = await ctx.db.get(row.userId);
    return {
      ok: true as const,
      userId: row.userId,
      issueId: row.issueId,
      // Kurzkennung fuer das Wasserzeichen im Reader.
      watermark: ((user as any)?.email ?? String(row.userId)).slice(0, 24),
    };
  },
});

export const reportUsageInternal = internalMutation({
  args: { sessionToken: v.string(), tiles: v.number() },
  handler: async (ctx, { sessionToken, tiles }) => {
    const row = await ctx.db
      .query("readerSessions")
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

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query("readerSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .collect();
    return Promise.all(
      rows
        .filter((r) => r.expiresAt >= now)
        .map(async (r) => ({
          _id: r._id,
          issueTitle: (await ctx.db.get(r.issueId))?.title ?? "",
          createdAt: r.createdAt,
          lastSeenAt: r.lastSeenAt ?? r.createdAt,
          tileCount: r.tileCount ?? 0,
        })),
    );
  },
});

export const revokeAllMine = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht angemeldet");
    const rows = await ctx.db
      .query("readerSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
