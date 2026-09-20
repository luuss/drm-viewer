import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { assetUrl } from "./assets";
import { Id } from "./_generated/dataModel";

const TOKEN_TTL_DAYS = 30;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const createInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    email: v.string(),
    stripeSessionId: v.optional(v.string()),
    externalOrderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Stripe wiederholt Ereignisse; ohne diese Pruefung entstuende je
    // Wiederholung ein weiterer einloesbarer Zugang.
    if (args.stripeSessionId) {
      const existing = await ctx.db
        .query("claimTokens")
        .withIndex("by_stripe_session", (q) =>
          q.eq("stripeSessionId", args.stripeSessionId),
        )
        .first();
      if (existing) return existing.token;
    }
    const token = randomToken();
    const now = Date.now();
    await ctx.db.insert("claimTokens", {
      token,
      issueId: args.issueId,
      email: args.email.toLowerCase(),
      stripeSessionId: args.stripeSessionId,
      externalOrderId: args.externalOrderId,
      expiresAt: now + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      createdAt: now,
    });
    return token;
  },
});

export const lookup = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("claimTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!row) return { status: "invalid" as const };
    if (row.claimedByUserId)
      return { status: "already_claimed" as const, email: row.email };
    if (row.expiresAt < Date.now()) return { status: "expired" as const };
    const issue = await ctx.db.get(row.issueId);
    return {
      status: "valid" as const,
      email: row.email,
      issue: issue
        ? {
            _id: issue._id,
            title: issue.title,
            pageCount: issue.pageCount,
            coverUrl: await assetUrl(ctx, issue.coverAssetId),
          }
        : null,
    };
  },
});

export const claim = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Bitte zuerst anmelden");

    const row = await ctx.db
      .query("claimTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!row) throw new Error("Ungültiger Link");
    if (row.claimedByUserId) throw new Error("Link bereits eingelöst");
    if (row.expiresAt < Date.now()) throw new Error("Link abgelaufen");

    // Der Link gehoert zur Kauf-Mailadresse, sonst waere er ein frei
    // weitergebbarer Zweitzugang.
    const user = await ctx.db.get(userId as Id<"users">);
    const email = ((user as any)?.email ?? "").toLowerCase();
    if (row.email && email !== row.email) {
      throw new Error(
        `Dieser Link gehört zu ${row.email}. Bitte mit dieser Adresse anmelden.`,
      );
    }

    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", userId as Id<"users">).eq("issueId", row.issueId),
      )
      .first();
    if (!existing) {
      await ctx.db.insert("entitlements", {
        userId: userId as Id<"users">,
        issueId: row.issueId,
        source: "claim",
        stripeSessionId: row.stripeSessionId,
        externalOrderId: row.externalOrderId,
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(row._id, {
      claimedByUserId: userId as Id<"users">,
      claimedAt: Date.now(),
    });
    return { issueId: row.issueId };
  },
});
