import { v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { DEFAULT_MAX_LOGINS } from "./magicLinkRules";

/**
 * Angemeldete Browser eines Kontos (Tabelle `authSessions` von Convex Auth).
 *
 * Ein Konto darf hoechstens MAX_LOGIN_SESSIONS (Standard 2) Browser zugleich
 * angemeldet haben. Eine neue Anmeldung beendet den aeltesten. Dieser Browser
 * merkt es sofort ueber `current` und meldet sich ab; spaetestens mit dem
 * Ablauf seines JWT (15 min) scheitert jeder Aufruf, weil das Auffrischen
 * ohne Sitzung nicht mehr geht. Lesesitzungen haengen an der Anmeldung und
 * enden mit ihr (`readerSessions.verifyInternal`).
 */

export function maxLogins(): number {
  const n = Number(process.env.MAX_LOGIN_SESSIONS ?? DEFAULT_MAX_LOGINS);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_LOGINS;
}

/** Eine Anmeldung sauber beenden: Sitzung, Auffrischtokens, Lesesitzungen, Geraetename. */
export async function endAuthSession(
  ctx: MutationCtx,
  sessionId: Id<"authSessions">,
): Promise<void> {
  for (;;) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
      .take(200);
    for (const t of tokens) await ctx.db.delete(t._id);
    if (tokens.length < 200) break;
  }
  const reader = await ctx.db
    .query("readerSessions")
    .withIndex("by_auth_session", (q) => q.eq("authSessionId", sessionId))
    .take(100);
  for (const r of reader) await ctx.db.delete(r._id);
  const info = await ctx.db
    .query("sessionInfo")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .take(10);
  for (const i of info) await ctx.db.delete(i._id);
  if (await ctx.db.get(sessionId)) await ctx.db.delete(sessionId);
}

/**
 * Vor jeder neuen Anmeldung: abgelaufene Sitzungen wegraeumen und die
 * aeltesten beenden, bis mit der neuen hoechstens `maxLogins()` bestehen.
 */
export async function makeRoomForLogin(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Id<"authSessions">[]> {
  const now = Date.now();
  const rows = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .take(200);
  const ended: Id<"authSessions">[] = [];
  const alive = [];
  for (const s of rows) {
    if (s.expirationTime < now) {
      await endAuthSession(ctx, s._id);
      continue;
    }
    alive.push(s);
  }
  alive.sort((a, b) => a._creationTime - b._creationTime);
  const keep = maxLogins() - 1;
  while (alive.length > keep) {
    const oldest = alive.shift()!;
    await endAuthSession(ctx, oldest._id);
    ended.push(oldest._id);
  }
  if (ended.length > 0) {
    console.log(
      JSON.stringify({ event: "login.evicted", userId, sessions: ended.length }),
    );
  }
  return ended;
}

/** Lebt die Anmeldung dieses Browsers noch? `null` ohne Anmeldung. */
export const current = query({
  args: {},
  returns: v.union(v.null(), v.object({ alive: v.boolean() })),
  handler: async (ctx) => {
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) return null;
    const session = await ctx.db.get(sessionId);
    return { alive: session !== null && session.expirationTime > Date.now() };
  },
});

/** Angemeldete Browser des Kontos fuer die Kontoseite. */
export const mine = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("authSessions"),
      createdAt: v.number(),
      lastActiveAt: v.number(),
      device: v.union(v.string(), v.null()),
      current: v.boolean(),
      reading: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const currentId = await getAuthSessionId(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .take(50);
    const out = [];
    for (const s of rows) {
      if (s.expirationTime < now) continue;
      const info = await ctx.db
        .query("sessionInfo")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .first();
      const lastToken = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
        .order("desc")
        .first();
      const reading = await ctx.db
        .query("readerSessions")
        .withIndex("by_auth_session", (q) => q.eq("authSessionId", s._id))
        .take(5);
      const titles: string[] = [];
      for (const r of reading) {
        if (r.expiresAt < now) continue;
        const issue = await ctx.db.get(r.issueId);
        if (issue) titles.push(issue.title);
      }
      out.push({
        _id: s._id,
        createdAt: s._creationTime,
        lastActiveAt: Math.max(s._creationTime, lastToken?._creationTime ?? 0),
        device: info?.device ?? null,
        current: s._id === currentId,
        reading: titles,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  },
});

/** Einen angemeldeten Browser abmelden (auch den eigenen). */
export const revoke = mutation({
  args: { sessionId: v.id("authSessions") },
  returns: v.object({ current: v.boolean() }),
  handler: async (ctx, { sessionId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht angemeldet");
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error("Diese Anmeldung gibt es nicht mehr");
    }
    const currentId = await getAuthSessionId(ctx);
    await endAuthSession(ctx, sessionId);
    return { current: sessionId === currentId };
  },
});

/**
 * Geraetebezeichnung der eigenen Anmeldung merken ("Chrome auf Android").
 * Der Browser meldet sie selbst; sie dient nur der Anzeige.
 */
export const describeCurrent = mutation({
  args: { device: v.string() },
  returns: v.null(),
  handler: async (ctx, { device }) => {
    const userId = await getAuthUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    if (!userId || !sessionId) return null;
    if (!(await ctx.db.get(sessionId))) return null;
    const clean = device.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
    if (!clean) return null;
    const existing = await ctx.db
      .query("sessionInfo")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (existing) {
      if (existing.device !== clean) await ctx.db.patch(existing._id, { device: clean });
    } else {
      await ctx.db.insert("sessionInfo", {
        sessionId,
        userId: userId as Id<"users">,
        device: clean,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});
