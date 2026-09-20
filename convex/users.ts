import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { rolesOf, hasRole, requireAdmin, audit, Role } from "./roles";
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
    await requireAdmin(ctx);
    const allowed = ["customer", "editor", "publisher", "admin"];
    const clean = roles.filter((r) => allowed.includes(r));
    await ctx.db.patch(userId, { roles: clean } as any);
    await audit(ctx, "user.setRoles", userId, clean.join(","));
  },
});
