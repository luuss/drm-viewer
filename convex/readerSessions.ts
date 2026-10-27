import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { hasIssueAccess } from "./access";
import { Doc, Id } from "./_generated/dataModel";
import { fnv1a32, kachelSchluessel } from "./schutz";
import { audit } from "./roles";

/** Geheimwert der Sitzung fuer den Kopierschutz. */
export function schutzSeedVon(row: Doc<"readerSessions">): number {
  return row.schutzSeed ?? fnv1a32(`alt:${row.sessionToken}`);
}

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Offene Hefte je Anmeldung (Browser). Die Zahl der Browser begrenzt
 * `sessions.ts` (MAX_LOGIN_SESSIONS, Standard 2); zusammen bremst das
 * geteilte Zugaenge. Frueher galt die Grenze je Konto, dadurch warfen sich
 * zwei eigene Geraete mit demselben Heft gegenseitig hinaus.
 */
const MAX_PER_LOGIN = Number(process.env.MAX_ACTIVE_SESSIONS ?? "2");

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
    const authSessionId = await getAuthSessionId(ctx);
    if (!userId || !authSessionId) throw new Error("Nicht angemeldet");
    // Das JWT gilt noch bis zu 15 min, nachdem die Anmeldung beendet wurde.
    if (!(await ctx.db.get(authSessionId))) throw new Error("Nicht angemeldet");
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) {
      throw new Error("Kein Zugriff auf diese Ausgabe");
    }

    const now = Date.now();
    const all = await ctx.db
      .query("readerSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .take(200);
    for (const o of all) {
      if (o.expiresAt < now) await ctx.db.delete(o._id);
    }
    const active = all.filter(
      (o) => o.expiresAt >= now && o.authSessionId === authSessionId,
    );

    const sameIssue = active.filter((o) => o.issueId === issueId);
    const fresh = sameIssue.find((o) => now - o.createdAt < REISSUE_COOLDOWN_MS);
    if (fresh) {
      return { token: fresh.sessionToken, expiresAt: fresh.expiresAt };
    }
    for (const o of sameIssue) await ctx.db.delete(o._id);

    const others = active.filter((o) => o.issueId !== issueId);
    if (others.length >= MAX_PER_LOGIN) {
      others.sort((a, b) => a.createdAt - b.createdAt);
      for (const d of others.slice(0, others.length - MAX_PER_LOGIN + 1)) {
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
    const seed = new Uint32Array(1);
    crypto.getRandomValues(seed);
    // Wasserzeichen-Kennung: 32 Bit, eindeutig.
    let code = 0;
    for (let versuch = 0; versuch < 5; versuch++) {
      const z = new Uint32Array(1);
      crypto.getRandomValues(z);
      const belegt = await ctx.db
        .query("wasserzeichen")
        .withIndex("by_code", (q) => q.eq("code", z[0]))
        .first();
      if (!belegt) {
        code = z[0];
        break;
      }
    }
    if (code) {
      await ctx.db.insert("wasserzeichen", {
        code,
        userId: userId as Id<"users">,
        issueId,
        createdAt: now,
      });
    }
    await ctx.db.insert("readerSessions", {
      schutzSeed: seed[0],
      ...(code ? { wasserzeichenCode: code } : {}),
      userId: userId as Id<"users">,
      authSessionId,
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
    // Abgemeldeter Browser (selbst, von der Kontoseite oder durch einen
    // dritten Login verdraengt): seine Lesesitzungen enden sofort.
    if (row.authSessionId && !(await ctx.db.get(row.authSessionId))) {
      return { ok: false, reason: "logged_out" as const };
    }
    // Zugriff bei jeder Pruefung neu ermitteln: ein Widerruf aus dem Laden
    // oder ein abgelaufenes Digital-Abo beendet auch eine laufende Sitzung.
    if (!(await hasIssueAccess(ctx, row.userId, row.issueId))) {
      return { ok: false, reason: "no_access" as const };
    }
    const user = await ctx.db.get(row.userId);
    return {
      ok: true as const,
      userId: row.userId,
      issueId: row.issueId,
      // Kurzkennung fuer das Wasserzeichen im Reader.
      watermark: ((user as any)?.email ?? String(row.userId)).slice(0, 24),
      // Nur fuer das Gateway: Schrift bauen, Kacheln verwuerfeln.
      schutzSeed: schutzSeedVon(row),
      kachelSchluessel: kachelSchluessel(schutzSeedVon(row)),
      wasserzeichenCode: row.wasserzeichenCode ?? null,
      sitzungSeit: row.createdAt,
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

/**
 * Der Reader hat offene Entwicklerwerkzeuge erkannt
 * (`web/src/reader/kopierschutz.ts`). Die Lesesitzung endet sofort, damit
 * auch keine Kachel und keine Schrift mehr kommt, und der Vorfall steht im
 * Protokoll.
 */
export const sperrenWegenDevtools = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("readerSessions")
      .withIndex("by_token", (q) => q.eq("sessionToken", sessionToken))
      .unique();
    if (!row || row.userId !== userId) return null;
    await ctx.db.delete(row._id);
    await audit(ctx, "reader.devtools", String(row.issueId), "Lesesitzung beendet");
    return null;
  },
});

/** Fuer das Wasserzeichen-Werkzeug im Gateway: wer steht hinter der Kennung? */
export const wasserzeichenAufloesenInternal = internalQuery({
  args: { code: v.number() },
  handler: async (ctx, { code }) => {
    const row = await ctx.db
      .query("wasserzeichen")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (!row) return null;
    const user = await ctx.db.get(row.userId);
    const issue = await ctx.db.get(row.issueId);
    return {
      userId: row.userId,
      email: (user as any)?.email ?? null,
      issueId: row.issueId,
      heft: issue?.title ?? null,
      gelesenAm: new Date(row.createdAt).toISOString(),
    };
  },
});
