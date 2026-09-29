import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { getAuthUserId, invalidateSessions } from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { endAuthSession } from "./sessions";
import { leserDatenLoeschen } from "./leserKasse";

export const setName = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht eingeloggt");
    await ctx.db.patch(userId, { name: name.trim().slice(0, 120) } as any);
  },
});

/**
 * Konto loeschen (DSGVO Art. 17). Entfernt Nutzerdaten inkl. Lesefortschritt,
 * Freischaltungen und Sitzungen. Kaufbelege bleiben anonymisiert erhalten,
 * weil sie steuerrechtlich aufbewahrungspflichtig sind.
 */
export const deleteMyAccount = action({
  args: { confirm: v.literal("LOESCHEN") },
  handler: async (ctx): Promise<{ ok: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht eingeloggt");
    const me: any = await ctx.runQuery(api.users.me, {});

    // Erst kuendigen, dann loeschen. Sonst laeuft die Abbuchung weiter,
    // waehrend der Zugang weg ist — das endet in Rueckbuchungen.
    const status: any = await ctx.runQuery(api.subscriptions.myStatus, {});
    for (const sub of status?.subscriptions ?? []) {
      if (["active", "trialing", "past_due"].includes(sub.status)) {
        try {
          await ctx.runAction(api.billing.cancelMySubscription, {
            stripeSubscriptionId: sub.stripeSubscriptionId,
            immediately: true,
          });
        } catch (err) {
          console.error("Abo-Kuendigung bei Kontoloeschung fehlgeschlagen", err);
          throw new Error(
            "Abo konnte nicht gekündigt werden. Bitte zuerst im Kundenportal kündigen.",
          );
        }
      }
    }

    await invalidateSessions(ctx, { userId });
    await ctx.runMutation(internal.account.purgeUserData, { userId });
    if (me?.email) {
      await ctx.runAction(internal.email.sendAccountDeleted, { email: me.email });
    }
    return { ok: true };
  },
});

export const purgeUserData = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => await purgeUser(ctx, userId),
});

async function purgeUser(ctx: MutationCtx, userId: Id<"users">) {
  // Kartenkauf im Leser: Adresse und Karte weg, Kaeufe anonym.
  await leserDatenLoeschen(ctx, userId);

  const ents = await ctx.db
    .query("entitlements")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const e of ents) await ctx.db.delete(e._id);

  const sessions = await ctx.db
    .query("readerSessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const s of sessions) await ctx.db.delete(s._id);

  const progress = await ctx.db
    .query("readingProgress")
    .withIndex("by_user_issue", (q) => q.eq("userId", userId))
    .collect();
  for (const p of progress) await ctx.db.delete(p._id);

  const subs = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const s of subs) await ctx.db.delete(s._id);

  // Kaeufe bleiben, aber ohne Personenbezug.
  const purchases = await ctx.db
    .query("purchases")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const p of purchases) {
    await ctx.db.patch(p._id, { userId: undefined, email: "geloescht" });
  }

  // Nicht eingeloeste Gutschein-Links des Kontos entfernen, eingeloeste
  // Verweise loesen. Beides ueber Index, damit die Loeschung auch bei
  // vielen Nutzern innerhalb der Leselimits bleibt.
  const claimed = await ctx.db
    .query("claimTokens")
    .withIndex("by_claimed_by", (q) => q.eq("claimedByUserId", userId))
    .collect();
  for (const c of claimed) await ctx.db.delete(c._id);

  // Zustimmungen bleiben als Nachweis, aber ohne Personenbezug.
  const consents = await ctx.db
    .query("consents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const c of consents) {
    await ctx.db.patch(c._id, { userId: undefined, email: undefined });
  }

  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const a of accounts) await ctx.db.delete(a._id);

  const authSessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const s of authSessions) await endAuthSession(ctx, s._id);

  const infos = await ctx.db
    .query("sessionInfo")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const i of infos) await ctx.db.delete(i._id);

  // Anmeldelinks tragen die Adresse; sie gehen mit.
  const email = ((await ctx.db.get(userId))?.email ?? "").toLowerCase();
  if (email) {
    const links = await ctx.db
      .query("magicLinks")
      .withIndex("by_email_and_createdAt", (q) => q.eq("email", email))
      .take(500);
    for (const l of links) await ctx.db.delete(l._id);
  }

  await ctx.db.delete(userId);
}

export const myAccountSummary = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => await ctx.db.get(userId),
});

/**
 * Alles zu einer Adresse entfernen: Konto (wie `purgeUserData`),
 * Freischaltungen aus dem Shop und Anmeldelinks. Fuer Testkonten und
 * Loeschanfragen per Mail. Nur mit dem Admin-Schluessel:
 * `npx convex run account:purgeByEmailInternal '{"email":"…"}'`.
 */
export const purgeByEmailInternal = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const e = email.trim().toLowerCase();
    const users = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", e))
      .take(10);
    for (const u of users) {
      await purgeUser(ctx, u._id);
    }
    let shop = 0;
    for (const row of await ctx.db
      .query("shopAccess")
      .withIndex("by_email", (q) => q.eq("email", e))
      .take(500)) {
      await ctx.db.delete(row._id);
      shop++;
    }
    for (const row of await ctx.db
      .query("shopGrants")
      .withIndex("by_email", (q) => q.eq("email", e))
      .take(500)) {
      await ctx.db.delete(row._id);
      shop++;
    }
    const links = await ctx.db
      .query("magicLinks")
      .withIndex("by_email_and_createdAt", (q) => q.eq("email", e))
      .take(500);
    for (const l of links) await ctx.db.delete(l._id);
    return { users: users.length, shop, links: links.length };
  },
});
