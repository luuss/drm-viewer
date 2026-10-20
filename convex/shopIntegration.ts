import { v, Infer } from "convex/values";
import { internalMutation, query, MutationCtx } from "./_generated/server";
import { requireAdmin } from "./roles";
import { Doc, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./access";
import { SHOP_URL } from "./shopCovers";
import { stripeCheckoutEnabled } from "./shopLinks";

/**
 * Server-zu-Server-Schnittstelle fuer den Laden (PrestaShop auf
 * lesenundschenken.de), Vertrag v2.
 *
 * Der Laden wickelt den Kauf ab, diese Plattform verwaltet nur den digitalen
 * Zugriff. Das Ladenmodul meldet jede bezahlte oder stornierte Bestellung mit
 * allen Positionen, auch der Druckware. Aufrufe sind ueber HMAC signiert
 * (siehe `http.ts`).
 *
 * Zuordnung der Artikelnummern:
 * - `issues.externalSku`               → Einzelheft, unbefristet
 * - `publications.shopSubscriptionSku` → Digital-Abo der Reihe fuer
 *   `shopSubscriptionMonths` Monate (ohne Angabe 12)
 * - alles andere                       → `unknown`, uebersprungen, kein Fehler
 *
 * Idempotent je Bestellung, Position und Aktion. Unbekannte Positionen werden
 * nicht als erledigt vermerkt: ordnet die Redaktion die Artikelnummer spaeter
 * zu, wirkt ein erneuter Aufruf des Ladens.
 *
 * Es wird kein Konto angelegt. Die Freischaltung haengt an der Adresse
 * (`shopAccess`) und greift, sobald sich jemand mit ihr anmeldet — auch mit
 * einem noch unbestaetigten Konto.
 */

export const DEFAULT_SUBSCRIPTION_MONTHS = 12;

const shopItem = v.object({
  sku: v.string(),
  lineId: v.string(),
  // Nur fuer das alte Einzelformat (`issueId` statt `issueSku`).
  issueId: v.optional(v.string()),
});

const itemResult = v.object({
  sku: v.string(),
  lineId: v.string(),
  kind: v.union(v.literal("issue"), v.literal("subscription"), v.literal("unknown")),
  ok: v.boolean(),
  message: v.optional(v.string()),
});
export type ShopItemResult = Infer<typeof itemResult>;

const orderResult = v.object({
  ok: v.literal(true),
  results: v.array(itemResult),
});

const orderArgs = {
  externalOrderId: v.string(),
  externalCustomerId: v.optional(v.string()),
  email: v.string(),
  action: v.union(v.literal("grant"), v.literal("revoke")),
  items: v.array(shopItem),
};

type OrderArgs = {
  externalOrderId: string;
  externalCustomerId?: string;
  email: string;
  action: "grant" | "revoke";
  items: Infer<typeof shopItem>[];
};

type Target =
  | { kind: "issue"; issue: Doc<"issues"> }
  | { kind: "subscription"; publication: Doc<"publications"> }
  | { kind: "unknown" };

/** Laufzeit eines Digital-Abos: ganze Monate zwischen 1 und 120. */
export function subscriptionMonths(publication: {
  shopSubscriptionMonths?: number;
}): number {
  const m = publication.shopSubscriptionMonths;
  if (m === undefined || !Number.isInteger(m) || m < 1 || m > 120) {
    return DEFAULT_SUBSCRIPTION_MONTHS;
  }
  return m;
}

/** Kalendermonate addieren (UTC). */
export function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

async function resolveTarget(
  ctx: MutationCtx,
  item: Infer<typeof shopItem>,
): Promise<Target> {
  if (item.issueId) {
    const id = ctx.db.normalizeId("issues", item.issueId);
    const issue = id ? await ctx.db.get(id) : null;
    if (issue) return { kind: "issue", issue };
  }
  const sku = item.sku.trim();
  if (!sku) return { kind: "unknown" };
  const issue = await ctx.db
    .query("issues")
    .withIndex("by_external_sku", (q) => q.eq("externalSku", sku))
    .first();
  if (issue) return { kind: "issue", issue };
  const publication = await ctx.db
    .query("publications")
    .withIndex("by_shop_subscription_sku", (q) =>
      q.eq("shopSubscriptionSku", sku),
    )
    .first();
  if (publication) return { kind: "subscription", publication };
  return { kind: "unknown" };
}

/**
 * Digital-Abo-Kaeufe einer Adresse fuer eine Reihe aneinanderreihen.
 *
 * Jeder Kauf beginnt bei max(Kaufzeitpunkt, Ende des vorigen) und laeuft
 * seine Monate. Widerrufene Kaeufe zaehlen nicht mit; die uebrigen ruecken
 * nach. Aufgerufen nach jedem Kauf und jedem Widerruf.
 */
export async function recomputeChain(
  ctx: MutationCtx,
  email: string,
  publicationId: Id<"publications">,
): Promise<number | null> {
  const rows = await ctx.db
    .query("shopAccess")
    .withIndex("by_email_publication", (q) =>
      q.eq("email", email).eq("publicationId", publicationId),
    )
    .take(500);
  const active = rows
    .filter((r) => r.kind === "subscription" && r.revokedAt === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
  let prevEnd = 0;
  for (const row of active) {
    const start = Math.max(row.createdAt, prevEnd);
    const end = addMonths(start, row.months ?? DEFAULT_SUBSCRIPTION_MONTHS);
    if (row.validFrom !== start || row.validUntil !== end) {
      await ctx.db.patch(row._id, { validFrom: start, validUntil: end, updatedAt: Date.now() });
    }
    prevEnd = end;
  }
  return active.length > 0 ? prevEnd : null;
}

async function grantItem(
  ctx: MutationCtx,
  args: OrderArgs,
  email: string,
  item: Infer<typeof shopItem>,
  target: Exclude<Target, { kind: "unknown" }>,
): Promise<string> {
  const now = Date.now();
  const existing = await ctx.db
    .query("shopAccess")
    .withIndex("by_order_line", (q) =>
      q.eq("externalOrderId", args.externalOrderId).eq("lineId", item.lineId),
    )
    .first();
  if (existing) {
    // Nur moeglich, wenn die Position vorher widerrufen wurde: ein erneutes
    // grant nach revoke wird ueber das Protokoll schon abgefangen.
    return "bereits vermerkt";
  }
  if (target.kind === "issue") {
    await ctx.db.insert("shopAccess", {
      email,
      externalOrderId: args.externalOrderId,
      lineId: item.lineId,
      externalCustomerId: args.externalCustomerId,
      sku: item.sku,
      kind: "issue",
      issueId: target.issue._id,
      createdAt: now,
      updatedAt: now,
    });
    return "freigeschaltet";
  }
  await ctx.db.insert("shopAccess", {
    email,
    externalOrderId: args.externalOrderId,
    lineId: item.lineId,
    externalCustomerId: args.externalCustomerId,
    sku: item.sku,
    kind: "subscription",
    publicationId: target.publication._id,
    months: subscriptionMonths(target.publication),
    createdAt: now,
    updatedAt: now,
  });
  const until = await recomputeChain(ctx, email, target.publication._id);
  return until ? `Digital-Abo bis ${formatDate(until)}` : "Digital-Abo vermerkt";
}

async function revokeItem(
  ctx: MutationCtx,
  args: OrderArgs,
  email: string,
  item: Infer<typeof shopItem>,
  target: Exclude<Target, { kind: "unknown" }>,
): Promise<string> {
  const row = await ctx.db
    .query("shopAccess")
    .withIndex("by_order_line", (q) =>
      q.eq("externalOrderId", args.externalOrderId).eq("lineId", item.lineId),
    )
    .first();

  // Freischaltungen aus Vertrag v1 stehen als Entitlement am Konto.
  let legacy = 0;
  if (target.kind === "issue") {
    const rows = await ctx.db
      .query("entitlements")
      .withIndex("by_external_order", (q) =>
        q.eq("externalOrderId", args.externalOrderId),
      )
      .take(200);
    for (const r of rows) {
      if (r.source !== "external_shop" || r.issueId !== target.issue._id) continue;
      await ctx.db.delete(r._id);
      legacy++;
    }
  }

  if (!row) {
    return legacy > 0 ? `${legacy} Freischaltung(en) entzogen` : "nichts zu entziehen";
  }
  if (row.revokedAt !== undefined) return "bereits entzogen";
  await ctx.db.patch(row._id, { revokedAt: Date.now(), updatedAt: Date.now() });
  if (row.kind === "subscription" && row.publicationId) {
    const until = await recomputeChain(ctx, row.email, row.publicationId);
    return until
      ? `entzogen, Digital-Abo aus anderen Käufen bis ${formatDate(until)}`
      : "Digital-Abo entzogen";
  }
  return "entzogen";
}

export async function applyOrder(
  ctx: MutationCtx,
  args: OrderArgs,
): Promise<{ ok: true; results: ShopItemResult[] }> {
  const email = normalizeEmail(args.email);
  const results: ShopItemResult[] = [];

  for (const item of args.items) {
    const already = await ctx.db
      .query("shopGrants")
      .withIndex("by_order_line_action", (q) =>
        q
          .eq("externalOrderId", args.externalOrderId)
          .eq("lineId", item.lineId)
          .eq("action", args.action),
      )
      .first();
    if (already) {
      results.push({
        sku: item.sku,
        lineId: item.lineId,
        kind: already.kind ?? "unknown",
        ok: true,
        message: `wiederholt: ${already.result}`,
      });
      continue;
    }

    const target = await resolveTarget(ctx, item);
    if (target.kind === "unknown") {
      results.push({
        sku: item.sku,
        lineId: item.lineId,
        kind: "unknown",
        ok: true,
        message: "keine digitale Ausgabe, übersprungen",
      });
      continue;
    }

    const result =
      args.action === "grant"
        ? await grantItem(ctx, args, email, item, target)
        : await revokeItem(ctx, args, email, item, target);

    const issueId = target.kind === "issue" ? target.issue._id : undefined;
    const publicationId =
      target.kind === "subscription" ? target.publication._id : undefined;
    await ctx.db.insert("shopGrants", {
      externalOrderId: args.externalOrderId,
      externalCustomerId: args.externalCustomerId,
      email,
      action: args.action,
      lineId: item.lineId,
      kind: target.kind,
      issueId,
      publicationId,
      issueSku: item.sku,
      result,
      createdAt: Date.now(),
    });
    await ctx.db.insert("auditLog", {
      action: `shop.${args.action}`,
      target: issueId ?? publicationId,
      detail: `${email} ${args.externalOrderId}/${item.lineId} ${item.sku}: ${result}`,
      createdAt: Date.now(),
    });
    results.push({
      sku: item.sku,
      lineId: item.lineId,
      kind: target.kind,
      ok: true,
      message: result,
    });
  }

  console.log(
    JSON.stringify({
      event: "shop.order",
      action: args.action,
      externalOrderId: args.externalOrderId,
      items: results.map((r) => `${r.kind}:${r.sku}`),
    }),
  );
  return { ok: true, results };
}

/** Vertrag v2: eine Bestellung mit allen Positionen. */
export const applyOrderInternal = internalMutation({
  args: orderArgs,
  returns: orderResult,
  handler: async (ctx, args) => await applyOrder(ctx, args),
});

/**
 * Altes Einzelformat (v1): eine Ausgabe je Aufruf ueber `issueSku` oder
 * `issueId`. Die Position heisst dann wie die Artikelnummer.
 */
export const applyInternal = internalMutation({
  args: {
    externalOrderId: v.string(),
    externalCustomerId: v.optional(v.string()),
    email: v.string(),
    issueSku: v.optional(v.string()),
    issueId: v.optional(v.string()),
    action: v.union(v.literal("grant"), v.literal("revoke")),
  },
  returns: orderResult,
  handler: async (ctx, args) =>
    await applyOrder(ctx, {
      externalOrderId: args.externalOrderId,
      externalCustomerId: args.externalCustomerId,
      email: args.email,
      action: args.action,
      items: [
        {
          sku: args.issueSku ?? "",
          lineId: args.issueSku ?? args.issueId ?? "",
          issueId: args.issueId,
        },
      ],
    }),
});

export const recentGrants = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("shopGrants").order("desc").take(50);
  },
});

// --- Laden als Kaufweg ------------------------------------------------------

/**
 * Eine Artikelnummer darf nur einmal vergeben sein — als Heft oder als
 * Digital-Abo einer Reihe. Sonst waere offen, was ein Kauf freischaltet.
 */
export async function assertSkuFree(
  ctx: MutationCtx,
  sku: string,
  own: { issueId?: Id<"issues">; publicationId?: Id<"publications"> },
): Promise<void> {
  const issue = await ctx.db
    .query("issues")
    .withIndex("by_external_sku", (q) => q.eq("externalSku", sku))
    .first();
  if (issue && issue._id !== own.issueId) {
    throw new Error(`Artikelnummer ${sku} gehört schon zur Ausgabe „${issue.title}“`);
  }
  const publication = await ctx.db
    .query("publications")
    .withIndex("by_shop_subscription_sku", (q) => q.eq("shopSubscriptionSku", sku))
    .first();
  if (publication && publication._id !== own.publicationId) {
    throw new Error(
      `Artikelnummer ${sku} ist schon das Digital-Abo von „${publication.name}“`,
    );
  }
}

/** Was die Oberflaeche ueber den Kaufweg wissen muss. */
export const storefront = query({
  args: {},
  returns: v.object({ stripeCheckout: v.boolean(), shopUrl: v.string() }),
  handler: async () => ({
    stripeCheckout: stripeCheckoutEnabled(),
    shopUrl: `${SHOP_URL}/`,
  }),
});
