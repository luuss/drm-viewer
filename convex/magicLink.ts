import { ConvexError, v } from "convex/values";
import { httpAction, internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { callShopApi } from "./shopApi";
import { appUrl } from "./mail";
import {
  LINK_TTL_MS,
  MAX_PER_EMAIL_PER_HOUR,
  MAX_PER_IP_PER_HOUR,
  MAX_TOTAL_PER_HOUR,
  buildLoginLink,
  isPlausibleEmail,
  normalizeEmail,
  safeNext,
} from "./magicLinkRules";

/**
 * Anmeldung ohne Passwort. Anmelden und Registrieren sind derselbe Weg:
 * Adresse eingeben, Link aus der Mail anklicken, angemeldet. Das Konto
 * entsteht erst beim ersten gueltigen Klick, denn erst dann ist die Adresse
 * bewiesen.
 *
 * - `POST /hooks/auth/link` (Rumpf `{email, next}`) legt einen Link an und
 *   laesst ihn vom Shop verschicken (Shop-API `send_mail`, Vorlage
 *   `lusdigital_login`). Die Antwort sagt nie, ob es die Adresse schon gibt.
 * - Der Link fuehrt auf `/anmelden?t=…`; die Seite ruft
 *   `signIn("magic-link", {token})` (Provider in auth.ts), der
 *   `consumeInternal` aufruft.
 *
 * Gespeichert wird nur der SHA-256 des Tokens. Ein Link gilt 15 Minuten und
 * nur einmal.
 */

const HOUR = 60 * 60 * 1000;
const KEEP_ROWS_MS = 24 * HOUR;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type RequestResult =
  | { ok: true; token: string; next: string }
  | { ok: false; reason: "rate_email" | "rate_ip" | "rate_total" };

/** Link anlegen, wenn die Grenzen es erlauben. Liefert das Token im Klartext genau einmal. */
export const requestInternal = internalMutation({
  args: { email: v.string(), ip: v.string(), next: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), token: v.string(), next: v.string() }),
    v.object({
      ok: v.literal(false),
      reason: v.union(v.literal("rate_email"), v.literal("rate_ip"), v.literal("rate_total")),
    }),
  ),
  handler: async (ctx, args): Promise<RequestResult> => {
    const email = normalizeEmail(args.email);
    const now = Date.now();
    const since = now - HOUR;

    const byEmail = await ctx.db
      .query("magicLinks")
      .withIndex("by_email_and_createdAt", (q) => q.eq("email", email).gt("createdAt", since))
      .take(MAX_PER_EMAIL_PER_HOUR);
    if (byEmail.length >= MAX_PER_EMAIL_PER_HOUR) return { ok: false, reason: "rate_email" };

    const byIp = await ctx.db
      .query("magicLinks")
      .withIndex("by_ip_and_createdAt", (q) => q.eq("ip", args.ip).gt("createdAt", since))
      .take(MAX_PER_IP_PER_HOUR);
    if (byIp.length >= MAX_PER_IP_PER_HOUR) return { ok: false, reason: "rate_ip" };

    const total = await ctx.db
      .query("magicLinks")
      .withIndex("by_createdAt", (q) => q.gt("createdAt", since))
      .take(MAX_TOTAL_PER_HOUR);
    if (total.length >= MAX_TOTAL_PER_HOUR) return { ok: false, reason: "rate_total" };

    const token = newToken();
    const next = safeNext(args.next);
    await ctx.db.insert("magicLinks", {
      email,
      tokenHash: await sha256Hex(token),
      ip: args.ip,
      next,
      createdAt: now,
      expiresAt: now + LINK_TTL_MS,
    });
    return { ok: true, token, next };
  },
});

/** Vermerk, dass der Shop die Mail nicht verschicken konnte (fuer die Fehlersuche). */
export const markFailedInternal = internalMutation({
  args: { email: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { email, error }) => {
    const row = await ctx.db
      .query("magicLinks")
      .withIndex("by_email_and_createdAt", (q) => q.eq("email", normalizeEmail(email)))
      .order("desc")
      .first();
    if (row && !row.usedAt) await ctx.db.patch(row._id, { sendError: error.slice(0, 200) });
    return null;
  },
});

/**
 * Konto zur Adresse finden oder anlegen. Bestehende Konten (frueher mit
 * Passwort) werden ueber `users.email` gefunden und behalten Id, Rollen,
 * Kaeufe und Freischaltungen. Freischaltungen aus dem Shop haengen ohnehin an
 * der Adresse (`shopAccess`).
 */
export async function userForEmail(ctx: MutationCtx, email: string): Promise<Id<"users">> {
  const now = Date.now();
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .take(10);
  let userId: Id<"users">;
  if (users.length === 0) {
    userId = await ctx.db.insert("users", { email, emailVerificationTime: now });
  } else {
    // Doppelte Konten sollte es nicht geben; sonst gewinnt das mit Rollen,
    // danach das aelteste.
    const pick =
      users.find((u) => Array.isArray(u.roles) && u.roles.length > 0) ??
      [...users].sort((a, b) => a._creationTime - b._creationTime)[0];
    userId = pick._id;
    if (pick.emailVerificationTime === undefined) {
      await ctx.db.patch(userId, { emailVerificationTime: now });
    }
  }
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "magic-link").eq("providerAccountId", email),
    )
    .unique();
  if (!account) {
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "magic-link",
      providerAccountId: email,
      emailVerified: email,
    });
  } else if (account.userId !== userId) {
    await ctx.db.patch(account._id, { userId });
  }
  return userId;
}

/**
 * Gastkaeufe ueber Stripe hinterlegen einen Einloeselink an der Kaufadresse
 * (`claimTokens`). Wer diese Adresse per Link beweist, bekommt sie direkt;
 * der Einloeseschritt entfaellt.
 */
async function redeemClaims(ctx: MutationCtx, userId: Id<"users">, email: string) {
  const claims = await ctx.db
    .query("claimTokens")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(200);
  for (const c of claims) {
    if (c.claimedByUserId) continue;
    if (c.stripeSessionId) {
      const purchase = await ctx.db
        .query("purchases")
        .withIndex("by_stripe_session", (q) => q.eq("stripeSessionId", c.stripeSessionId!))
        .first();
      if (purchase && (purchase.status === "refunded" || purchase.status === "failed")) continue;
    }
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) => q.eq("userId", userId).eq("issueId", c.issueId))
      .first();
    if (!existing) {
      await ctx.db.insert("entitlements", {
        userId,
        issueId: c.issueId,
        source: "claim",
        stripeSessionId: c.stripeSessionId,
        externalOrderId: c.externalOrderId,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(c._id, { claimedByUserId: userId, claimedAt: Date.now() });
  }
}

/**
 * Link einloesen. Wirft `ConvexError({grund})` mit `unbekannt`, `benutzt`
 * oder `abgelaufen`; die Oberflaeche zeigt dazu einen Satz.
 */
export const consumeInternal = internalMutation({
  args: { token: v.string() },
  returns: v.object({ userId: v.id("users"), next: v.string() }),
  handler: async (ctx, { token }) => {
    const hash = await sha256Hex(token);
    const link = await ctx.db
      .query("magicLinks")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
      .unique();
    if (!link) throw new ConvexError({ grund: "unbekannt" });
    if (link.usedAt !== undefined) throw new ConvexError({ grund: "benutzt" });
    if (link.expiresAt < Date.now()) throw new ConvexError({ grund: "abgelaufen" });
    await ctx.db.patch(link._id, { usedAt: Date.now() });

    const userId = await userForEmail(ctx, link.email);
    await redeemClaims(ctx, userId, link.email);
    console.log(JSON.stringify({ event: "login.link", userId }));
    return { userId, next: link.next };
  },
});

/** Alte Links wegraeumen (Cron). Einloesen geht nach 15 min ohnehin nicht mehr. */
export const cleanupInternal = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - KEEP_ROWS_MS;
    const old = await ctx.db
      .query("magicLinks")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return old.length;
  },
});

/** Client-IP hinter Cloudflare und Apache. */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  const xff = headers.get("x-forwarded-for")?.split(",")[0];
  const ip = (cf ?? xff ?? "").trim().slice(0, 64);
  return ip || "unbekannt";
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** `POST /auth/link` (von aussen `/hooks/auth/link`). */
export const requestLinkHttp = httpAction(async (ctx, request) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, error: "bad_json" });
  }
  const email = normalizeEmail(typeof body?.email === "string" ? body.email : "");
  if (!isPlausibleEmail(email)) return json(400, { ok: false, error: "bad_email" });

  const result: RequestResult = await ctx.runMutation(internal.magicLink.requestInternal, {
    email,
    ip: clientIp(request.headers),
    next: typeof body?.next === "string" ? body.next : "",
  });
  if (!result.ok) {
    console.log(JSON.stringify({ event: "login.link.limited", reason: result.reason }));
    return json(429, { ok: false, error: "rate_limited" });
  }

  const link = buildLoginLink(appUrl(), result.token, result.next);
  try {
    await callShopApi("send_mail", { template: "lusdigital_login", to: email, link });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    console.error("Anmeldelink: Shop konnte nicht senden", message);
    await ctx.runMutation(internal.magicLink.markFailedInternal, { email, error: message });
    return json(502, { ok: false, error: "mail_failed" });
  }
  return json(200, { ok: true });
});
