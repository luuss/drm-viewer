import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isAdminEmail, requireAdmin } from "./admin";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const email = (user as any).email ?? null;
    return {
      _id: user._id,
      email,
      name: (user as any).name ?? null,
      emailVerified: (user as any).emailVerificationTime != null,
      isAdmin: isAdminEmail(email),
    };
  },
});

/** Wirft, wenn der Aufrufer kein Admin ist. Fuer Actions, die keine DB sehen. */
export const requireAdminQuery = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return true;
  },
});
