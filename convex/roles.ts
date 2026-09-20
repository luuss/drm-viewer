import { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

export type Role = "customer" | "editor" | "publisher" | "admin";

/** Wer mehr darf, darf auch das Geringere. */
const IMPLIED: Record<Role, Role[]> = {
  admin: ["admin", "publisher", "editor", "customer"],
  publisher: ["publisher", "editor", "customer"],
  editor: ["editor", "customer"],
  customer: ["customer"],
};

function bootstrapAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Die E-Mail-Liste ist nur noch der Erstzugang: wer darin steht, gilt als
 * Admin, damit ueberhaupt jemand Rollen vergeben kann. Alles Weitere steht am
 * Nutzer.
 */
export function rolesOf(user: any): Role[] {
  const stored: Role[] = Array.isArray(user?.roles) ? user.roles : [];
  const email = (user?.email ?? "").toLowerCase();
  const isBootstrapAdmin = email && bootstrapAdminEmails().includes(email);
  const base: Role[] = stored.length > 0 ? stored : ["customer"];
  const all = isBootstrapAdmin ? [...base, "admin"] : base;
  const expanded = new Set<Role>();
  for (const r of all) {
    for (const implied of IMPLIED[r as Role] ?? ["customer"]) {
      expanded.add(implied);
    }
  }
  return Array.from(expanded);
}

export function hasRole(user: any, role: Role): boolean {
  return rolesOf(user).includes(role);
}

export async function currentUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return await ctx.db.get(userId as Id<"users">);
}

export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Nicht angemeldet");
  return userId as Id<"users">;
}

export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  role: Role,
): Promise<Id<"users">> {
  const userId = await requireUserId(ctx);
  const user = await ctx.db.get(userId);
  if (!hasRole(user, role)) {
    throw new Error(`Fehlende Berechtigung: ${role}`);
  }
  return userId;
}

export const requireEditor = (ctx: QueryCtx | MutationCtx) =>
  requireRole(ctx, "editor");
export const requirePublisher = (ctx: QueryCtx | MutationCtx) =>
  requireRole(ctx, "publisher");
export const requireAdmin = (ctx: QueryCtx | MutationCtx) =>
  requireRole(ctx, "admin");

/** Fuer Actions, die keine Datenbank sehen: Pruefung ueber eine Query. */
export async function requireRoleViaQuery(
  ctx: ActionCtx,
  api: any,
  role: Role,
): Promise<void> {
  await ctx.runQuery(api.users.requireRoleQuery, { role });
}

/** Protokolleintrag fuer Eingriffe, die jemand spaeter nachvollziehen muss. */
export async function audit(
  ctx: MutationCtx,
  action: string,
  target?: string,
  detail?: string,
) {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get(userId as Id<"users">) : null;
  await ctx.db.insert("auditLog", {
    actorUserId: (userId as Id<"users">) ?? undefined,
    actorEmail: (user as any)?.email ?? undefined,
    action,
    target,
    detail,
    createdAt: Date.now(),
  });
}
