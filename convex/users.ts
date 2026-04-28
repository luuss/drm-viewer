import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isAdminEmail } from "./admin";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const email = (user as any).email ?? null;
    return { _id: user._id, email, isAdmin: isAdminEmail(email) };
  },
});
