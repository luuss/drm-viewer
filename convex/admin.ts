import { QueryCtx, MutationCtx, ActionCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export async function requireAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<void> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Nicht eingeloggt");
  const user = await ctx.db.get(userId);
  const email = (user as any)?.email as string | null | undefined;
  if (!isAdminEmail(email)) {
    throw new Error("Admin-Zugriff erforderlich");
  }
}
