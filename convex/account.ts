import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation } from "./_generated/server";
import {
  getAuthUserId,
  modifyAccountCredentials,
  retrieveAccount,
  invalidateSessions,
} from "@convex-dev/auth/server";
import { api, internal } from "./_generated/api";
import { DataModel, Id } from "./_generated/dataModel";

/** Passwort aendern: altes Passwort wird geprueft, danach laufen alle Sitzungen ab. */
export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, { currentPassword, newPassword }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht eingeloggt");
    const me: any = await ctx.runQuery(api.users.me, {});
    if (!me?.email) throw new Error("Kein E-Mail-Konto vorhanden");

    if (newPassword.length < 10) {
      throw new Error("Passwort muss mindestens 10 Zeichen haben");
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      throw new Error("Passwort braucht Buchstaben und Ziffern");
    }

    const account = await retrieveAccount(ctx, {
      provider: "password",
      account: { id: me.email, secret: currentPassword },
    });
    if (!account) throw new Error("Aktuelles Passwort stimmt nicht");

    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: me.email, secret: newPassword },
    });
    // Andere Geraete abmelden — Passwortwechsel soll gestohlene Sitzungen beenden.
    await invalidateSessions(ctx, { userId });
    return { ok: true };
  },
});

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
  handler: async (ctx, { userId }) => {
    const ents = await ctx.db
      .query("entitlements")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const e of ents) await ctx.db.delete(e._id);

    const sessions = await ctx.db
      .query("tileSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const s of sessions) await ctx.db.delete(s._id);

    const progress = await ctx.db
      .query("readingProgress")
      .withIndex("by_user_book", (q) => q.eq("userId", userId))
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
    for (const s of authSessions) await ctx.db.delete(s._id);

    await ctx.db.delete(userId);
  },
});

export const myAccountSummary = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => await ctx.db.get(userId),
});
