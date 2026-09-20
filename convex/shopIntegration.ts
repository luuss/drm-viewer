import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireAdmin } from "./roles";
import { Id } from "./_generated/dataModel";

/**
 * Server-zu-Server-Schnittstelle fuer einen bestehenden Onlineshop.
 *
 * Der Shop wickelt den Kauf ab, diese Plattform verwaltet nur den digitalen
 * Zugriff. Aufrufe sind ueber HMAC signiert (siehe `http.ts`) und ueber
 * `externalOrderId` je Aktion nur einmal wirksam.
 *
 * Bewusste Grenze: es wird kein Konto angelegt. Gibt es zur Adresse kein Konto,
 * antwortet die Schnittstelle mit einem klaren Fehler — der Shop soll den
 * Kunden zur Registrierung schicken, statt hier Karteileichen zu erzeugen.
 * Ein vorhandenes, noch unbestaetigtes Konto bekommt den Zugriff trotzdem.
 */
export const applyInternal = internalMutation({
  args: {
    externalOrderId: v.string(),
    externalCustomerId: v.optional(v.string()),
    email: v.string(),
    issueSku: v.optional(v.string()),
    issueId: v.optional(v.id("issues")),
    action: v.union(v.literal("grant"), v.literal("revoke")),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();

    const already = await ctx.db
      .query("shopGrants")
      .withIndex("by_order_action", (q) =>
        q.eq("externalOrderId", args.externalOrderId).eq("action", args.action),
      )
      .first();
    if (already) {
      return { ok: true, idempotent: true, result: already.result };
    }

    let issue = args.issueId ? await ctx.db.get(args.issueId) : null;
    if (!issue && args.issueSku) {
      issue = await ctx.db
        .query("issues")
        .withIndex("by_external_sku", (q) => q.eq("externalSku", args.issueSku))
        .first();
    }
    if (!issue) {
      return {
        ok: false,
        error: "issue_not_found",
        message: `Keine Ausgabe zu ${args.issueSku ?? args.issueId}`,
      };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) {
      return {
        ok: false,
        error: "account_not_found",
        message: `Kein Konto für ${email}. Der Kunde muss sich zuerst registrieren.`,
      };
    }

    let result: string;
    if (args.action === "grant") {
      const existing = await ctx.db
        .query("entitlements")
        .withIndex("by_user_issue", (q) =>
          q.eq("userId", user._id as Id<"users">).eq("issueId", issue!._id),
        )
        .first();
      if (existing) {
        result = "bereits freigeschaltet";
      } else {
        await ctx.db.insert("entitlements", {
          userId: user._id as Id<"users">,
          issueId: issue._id,
          source: "external_shop",
          externalOrderId: args.externalOrderId,
          createdAt: Date.now(),
        });
        result = "freigeschaltet";
      }
    } else {
      const rows = await ctx.db
        .query("entitlements")
        .withIndex("by_user_issue", (q) =>
          q.eq("userId", user._id as Id<"users">).eq("issueId", issue!._id),
        )
        .collect();
      let n = 0;
      for (const r of rows) {
        // Nur widerrufen, was der Shop selbst vergeben hat.
        if (r.source !== "external_shop") continue;
        await ctx.db.delete(r._id);
        n++;
      }
      result = `${n} Freischaltung(en) entzogen`;
    }

    await ctx.db.insert("shopGrants", {
      externalOrderId: args.externalOrderId,
      externalCustomerId: args.externalCustomerId,
      email,
      action: args.action,
      issueId: issue._id,
      issueSku: args.issueSku,
      result,
      createdAt: Date.now(),
    });
    await ctx.db.insert("auditLog", {
      action: `shop.${args.action}`,
      target: issue._id,
      detail: `${email}: ${result}`,
      createdAt: Date.now(),
    });
    console.log(
      JSON.stringify({
        event: "shop.entitlement",
        action: args.action,
        issueId: issue._id,
        result,
      }),
    );
    return { ok: true, idempotent: false, result, issueId: issue._id };
  },
});

export const recentGrants = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("shopGrants").order("desc").take(50);
  },
});
