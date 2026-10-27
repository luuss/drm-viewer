import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { rolesOf, hasRole, requireAdmin, audit, Role, darfRollenVergeben } from "./roles";
import { Id } from "./_generated/dataModel";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId as Id<"users">);
    if (!user) return null;
    const roles = rolesOf(user);
    return {
      _id: user._id,
      email: (user as any).email ?? null,
      name: (user as any).name ?? null,
      emailVerified: (user as any).emailVerificationTime != null,
      roles,
      isEditor: roles.includes("editor"),
      isPublisher: roles.includes("publisher"),
      isAdmin: roles.includes("admin"),
      darfRollenVergeben: darfRollenVergeben(user),
    };
  },
});

/** Rollenpruefung fuer Actions, die keine Datenbank sehen. */
export const requireRoleQuery = query({
  args: { role: v.string() },
  handler: async (ctx, { role }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht angemeldet");
    const user = await ctx.db.get(userId as Id<"users">);
    if (!hasRole(user, role as Role)) {
      throw new Error(`Fehlende Berechtigung: ${role}`);
    }
    return true;
  },
});

export const listForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db.query("users").collect();
    return rows.map((u) => ({
      _id: u._id,
      email: (u as any).email ?? null,
      name: (u as any).name ?? null,
      roles: rolesOf(u),
    }));
  },
});

export const setRoles = mutation({
  args: { userId: v.id("users"), roles: v.array(v.string()) },
  handler: async (ctx, { userId, roles }) => {
    const adminId = await requireAdmin(ctx);
    if (!darfRollenVergeben(await ctx.db.get(adminId))) {
      throw new Error("Rollen vergeben duerfen nur ausgewaehlte Konten");
    }
    const allowed = ["customer", "reader", "editor", "publisher", "admin"];
    const clean = roles.filter((r) => allowed.includes(r));
    await ctx.db.patch(userId, { roles: clean } as any);
    await audit(ctx, "user.setRoles", userId, clean.join(","));
  },
});

/** Tabellen, deren Zeilen mit dem Konto verschwinden (Feld `userId`). */
const KONTO_TABELLEN = [
  "entitlements",
  "subscriptions",
  "readingProgress",
  "readerSessions",
  "sessionInfo",
  "leserKunden",
  "leserKarten",
  "leserKaeufe",
  "wasserzeichen",
  "purchases",
  "consents",
] as const;

/**
 * Konten samt Anmeldung, Sitzungen, Freischaltungen und Lesestand loeschen,
 * z. B. Testkonten. Protokoll, Importe und Freiexemplar-Belege bleiben als
 * Historie. Aufruf von Hand:
 * `npx convex run users:loeschenInternal '{"emails":["a@b.de"]}'`
 */
export const loeschenInternal = internalMutation({
  args: { emails: v.array(v.string()) },
  returns: v.array(v.object({ email: v.string(), geloescht: v.boolean(), zeilen: v.number() })),
  handler: async (ctx, { emails }) => {
    const out = [];
    for (const roh of emails) {
      const email = roh.trim().toLowerCase();
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      if (!user) {
        out.push({ email, geloescht: false, zeilen: 0 });
        continue;
      }
      let zeilen = 0;
      for (const tabelle of KONTO_TABELLEN) {
        const rows = await (ctx.db.query(tabelle as any) as any).collect();
        for (const row of rows) {
          if (row.userId === user._id) {
            await ctx.db.delete(row._id);
            zeilen++;
          }
        }
      }
      const sitzungen = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", user._id))
        .collect();
      for (const s of sitzungen) {
        const tokens = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
          .collect();
        for (const t of tokens) await ctx.db.delete(t._id);
        await ctx.db.delete(s._id);
        zeilen++;
      }
      const konten = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
        .collect();
      for (const k of konten) {
        const codes = await ctx.db
          .query("authVerificationCodes")
          .withIndex("accountId", (q) => q.eq("accountId", k._id))
          .collect();
        for (const c of codes) await ctx.db.delete(c._id);
        await ctx.db.delete(k._id);
        zeilen++;
      }
      await ctx.db.delete(user._id);
      await audit(ctx, "user.delete", user._id, email);
      out.push({ email, geloescht: true, zeilen });
    }
    return out;
  },
});
