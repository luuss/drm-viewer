import { v, Infer } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAdmin, audit } from "./roles";
import {
  ShopApiError,
  ShopProduct,
  callShopApi,
  digitalSku,
  parseProduct,
  parseProducts,
  rankProducts,
  suggestQuery,
} from "./shopApi";

/**
 * Zuordnung eines Hefts zum Druckheft im Laden und die Digital-Variante dort.
 *
 * Ablauf in der Redaktion: nach dem Import schlaegt der Leser das passende
 * Druckheft vor (Suche mit Reihe und Heftnummer), die Redaktion bestaetigt
 * oder waehlt um. Mit der Auswahl kommen Preis (Quelle "laden", die Redaktion
 * geht vor), Produktseite und — falls noch keins da ist — das Titelbild.
 * Danach legt "Im Shop als E-Paper anbieten" die Variante im Laden an.
 * Veroeffentlichen im Leser bleibt ein eigener Schritt.
 *
 * Alle Aufrufe nur fuer Admins. Laeuft im Standard-Laufzeitsystem; `fetch`
 * und Web Crypto reichen, "use node" ist nicht noetig.
 */

const productValidator = v.object({
  id: v.number(),
  name: v.string(),
  reference: v.string(),
  priceCents: v.union(v.number(), v.null()),
  url: v.string(),
  coverUrl: v.union(v.string(), v.null()),
  manufacturer: v.string(),
  active: v.boolean(),
  digital: v.union(
    v.null(),
    v.object({
      idProductAttribute: v.number(),
      sku: v.string(),
      priceCents: v.union(v.number(), v.null()),
      available: v.boolean(),
    }),
  ),
});

const digitalStatus = v.object({
  offered: v.boolean(),
  idProductAttribute: v.optional(v.number()),
  sku: v.optional(v.string()),
  priceCents: v.optional(v.number()),
  url: v.optional(v.string()),
  syncedAt: v.number(),
});

type DigitalStatus = Infer<typeof digitalStatus>;
type Product = Infer<typeof productValidator>;

/** Was die Aktionen ueber ein Heft wissen muessen (contextInternal). */
type IssueContext = {
  issueId: Id<"issues">;
  title: string;
  issueNumber: string | null;
  priceAmountCents: number;
  shopProductId: number | null;
  externalSku: string | null;
  publicationName: string;
  publicationSlug: string;
};

const MAX_SKU_TRIES = 50;

/** Fehler des Ladens als lesbarer Satz; alles andere unveraendert. */
async function shop(
  actionName: Parameters<typeof callShopApi>[0],
  params: Record<string, unknown>,
) {
  try {
    return await callShopApi(actionName, params);
  } catch (error) {
    if (error instanceof ShopApiError) throw new Error(error.message);
    throw error;
  }
}

// --- intern -----------------------------------------------------------------

export const requireAdminInternal = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return true;
  },
});

export const contextInternal = internalQuery({
  args: { issueId: v.id("issues") },
  returns: v.object({
    issueId: v.id("issues"),
    title: v.string(),
    issueNumber: v.union(v.string(), v.null()),
    priceAmountCents: v.number(),
    shopProductId: v.union(v.number(), v.null()),
    externalSku: v.union(v.string(), v.null()),
    publicationName: v.string(),
    publicationSlug: v.string(),
  }),
  handler: async (ctx, { issueId }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue) throw new Error("Ausgabe nicht gefunden");
    const publication = await ctx.db.get(issue.publicationId);
    return {
      issueId,
      title: issue.title,
      issueNumber: issue.issueNumber ?? null,
      priceAmountCents: issue.priceAmountCents,
      shopProductId: issue.shopProductId ?? null,
      externalSku: issue.externalSku ?? null,
      publicationName: publication?.name ?? "",
      publicationSlug: publication?.slug ?? "",
    };
  },
});

async function skuTaken(ctx: MutationCtx, sku: string, issueId: Id<"issues">) {
  const issue = await ctx.db
    .query("issues")
    .withIndex("by_external_sku", (q) => q.eq("externalSku", sku))
    .first();
  if (issue && issue._id !== issueId) return true;
  const publication = await ctx.db
    .query("publications")
    .withIndex("by_shop_subscription_sku", (q) => q.eq("shopSubscriptionSku", sku))
    .first();
  return publication !== null;
}

/**
 * Artikelnummer der Digital-Variante sicherstellen. Eine vorhandene bleibt;
 * sonst die des Ladens (falls frei), sonst `<KUERZEL>-<NR>-DIGITAL`, bei
 * Kollision mit angehaengter Zahl.
 */
async function ensureSku(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  fromShop?: string,
): Promise<string> {
  const issue = await ctx.db.get(issueId);
  if (!issue) throw new Error("Ausgabe nicht gefunden");
  if (issue.externalSku) return issue.externalSku;
  const publication = await ctx.db.get(issue.publicationId);
  const candidates: string[] = [];
  if (fromShop) candidates.push(fromShop);
  const base = digitalSku(
    { name: publication?.name ?? "", slug: publication?.slug ?? "" },
    { issueNumber: issue.issueNumber, _id: issueId },
  );
  candidates.push(base);
  for (let n = 2; n <= MAX_SKU_TRIES; n++) candidates.push(`${base}-${n}`);
  for (const sku of candidates) {
    if (await skuTaken(ctx, sku, issueId)) continue;
    await ctx.db.patch(issueId, { externalSku: sku, updatedAt: Date.now() });
    return sku;
  }
  throw new Error("Keine freie Artikelnummer gefunden. Bitte von Hand eintragen.");
}

function statusFrom(product: ShopProduct) {
  const d = product.digital;
  return {
    offered: !!d && d.available,
    idProductAttribute: d?.idProductAttribute,
    sku: d?.sku || undefined,
    priceCents: d?.priceCents ?? undefined,
    syncedAt: Date.now(),
  };
}

export const applyProductInternal = internalMutation({
  args: { issueId: v.id("issues"), product: productValidator },
  returns: v.object({
    priceTaken: v.boolean(),
    sku: v.string(),
    needsCover: v.boolean(),
  }),
  handler: async (ctx, { issueId, product }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue) throw new Error("Ausgabe nicht gefunden");
    // Rangfolge Redaktion → Laden → Impressum: was die Redaktion eingetragen
    // hat, bleibt stehen.
    const priceTaken =
      product.priceCents !== null &&
      product.priceCents > 0 &&
      issue.priceSource !== "redaktion";
    await ctx.db.patch(issueId, {
      shopProductId: product.id,
      shopUrl: product.url,
      shopDigital: statusFrom(product),
      shopSyncedAt: Date.now(),
      updatedAt: Date.now(),
      ...(priceTaken
        ? {
            priceAmountCents: product.priceCents!,
            priceSource: "laden" as const,
            // Ein neuer Preis macht den hinterlegten Stripe-Preis ungueltig.
            ...(product.priceCents !== issue.priceAmountCents
              ? { stripePriceId: undefined }
              : {}),
          }
        : {}),
    });
    const sku = await ensureSku(ctx, issueId, product.digital?.sku || undefined);
    await audit(ctx, "issue.shopProduct", issueId, `${product.id} ${product.name}`);
    return { priceTaken, sku, needsCover: !issue.coverAssetId };
  },
});

export const setCoverInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    storageId: v.id("_storage"),
    contentType: v.string(),
    bytes: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    // Zwischenzeitlich hat der Import ein Titelbild gebracht: das gewinnt.
    if (!issue || issue.coverAssetId) {
      await ctx.storage.delete(args.storageId);
      return false;
    }
    const assetId = await ctx.db.insert("assets", {
      key: `issues/${args.issueId}/cover-shop.jpg`,
      contentType: args.contentType,
      bytes: args.bytes,
      kind: "cover",
      issueId: args.issueId,
      convexStorageId: args.storageId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.issueId, { coverAssetId: assetId, updatedAt: Date.now() });
    return true;
  },
});

export const ensureSkuInternal = internalMutation({
  args: { issueId: v.id("issues") },
  returns: v.string(),
  handler: async (ctx, { issueId }) => await ensureSku(ctx, issueId),
});

export const setDigitalInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    status: digitalStatus,
    shopUrl: v.optional(v.string()),
    auditAction: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { issueId, status, shopUrl, auditAction }) => {
    await ctx.db.patch(issueId, {
      shopDigital: status,
      ...(shopUrl ? { shopUrl } : {}),
      updatedAt: Date.now(),
    });
    if (auditAction) await audit(ctx, auditAction, issueId, status.sku ?? "");
    return null;
  },
});

// --- Aktionen fuer die Redaktion ---------------------------------------------

/**
 * Druckhefte im Laden suchen. Ohne Suchbegriff der Vorschlag aus Reihe und
 * Heftnummer; die Treffer kommen geordnet, der erste ist der Vorschlag.
 */
export const search = action({
  args: { issueId: v.id("issues"), q: v.optional(v.string()) },
  returns: v.object({ query: v.string(), products: v.array(productValidator) }),
  handler: async (ctx, { issueId, q }): Promise<{ query: string; products: Product[] }> => {
    await ctx.runQuery(internal.shopCatalog.requireAdminInternal, {});
    const c: IssueContext = await ctx.runQuery(internal.shopCatalog.contextInternal, {
      issueId,
    });
    const publication = { name: c.publicationName, slug: c.publicationSlug };
    const query =
      q?.trim().slice(0, 120) ||
      suggestQuery(publication, { title: c.title, issueNumber: c.issueNumber ?? undefined });
    const json = await shop("search", { q: query });
    const products = rankProducts(parseProducts(json), publication, c.issueNumber ?? undefined);
    return { query, products: products.slice(0, 30) };
  },
});

/** Druckheft uebernehmen: Zuordnung, Preis, Produktseite, ggf. Titelbild. */
export const select = action({
  args: { issueId: v.id("issues"), productId: v.number() },
  returns: v.object({ messages: v.array(v.string()) }),
  handler: async (ctx, { issueId, productId }): Promise<{ messages: string[] }> => {
    await ctx.runQuery(internal.shopCatalog.requireAdminInternal, {});
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new Error("Ungültige Produktnummer");
    }
    const json = await shop("product", { id: productId });
    const product = parseProduct(json.product);
    if (!product) throw new Error("Der Shop lieferte kein gültiges Produkt.");
    const applied: { priceTaken: boolean; sku: string; needsCover: boolean } =
      await ctx.runMutation(internal.shopCatalog.applyProductInternal, {
      issueId,
      product,
    });
    const messages: string[] = [`Zugeordnet: ${product.name}`, `Artikelnummer ${applied.sku}`];
    if (applied.priceTaken && product.priceCents !== null) {
      messages.push(`Preis ${(product.priceCents / 100).toFixed(2)} € aus dem Shop`);
    }
    if (applied.needsCover && product.coverUrl) {
      messages.push(
        (await takeCover(ctx, issueId, product.coverUrl))
          ? "Titelbild aus dem Shop übernommen"
          : "Titelbild aus dem Shop nicht ladbar",
      );
    }
    return { messages };
  },
});

async function takeCover(ctx: any, issueId: Id<"issues">, url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "LesenUndSchenkenDigital/1.0" },
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.startsWith("image/")) return false;
    const blob = await response.blob();
    if (blob.size < 5_000 || blob.size > 20_000_000) return false;
    const storageId = await ctx.storage.store(blob);
    return await ctx.runMutation(internal.shopCatalog.setCoverInternal, {
      issueId,
      storageId,
      contentType: blob.type || type,
      bytes: blob.size,
    });
  } catch (error) {
    console.error("Titelbild aus dem Shop", error);
    return false;
  }
}

/** Digital-Variante im Laden anlegen bzw. wieder verfuegbar machen. */
export const offer = action({
  args: { issueId: v.id("issues") },
  returns: digitalStatus,
  handler: async (ctx, { issueId }): Promise<DigitalStatus> => {
    await ctx.runQuery(internal.shopCatalog.requireAdminInternal, {});
    const c: IssueContext = await ctx.runQuery(internal.shopCatalog.contextInternal, {
      issueId,
    });
    if (!c.shopProductId) throw new Error("Erst das Druckheft im Shop auswählen.");
    if (c.priceAmountCents <= 0) throw new Error("Die Ausgabe hat keinen Preis.");
    const sku: string = await ctx.runMutation(internal.shopCatalog.ensureSkuInternal, {
      issueId,
    });
    const json = await shop("offer_digital", {
      id_product: c.shopProductId,
      sku,
      price_gross: c.priceAmountCents / 100,
      available: true,
    });
    const attr = Number(json.id_product_attribute);
    const url = typeof json.url === "string" && /^https?:\/\//.test(json.url) ? json.url : undefined;
    const status: DigitalStatus = {
      offered: true,
      idProductAttribute: Number.isInteger(attr) && attr > 0 ? attr : undefined,
      sku,
      priceCents: c.priceAmountCents,
      url,
      syncedAt: Date.now(),
    };
    await ctx.runMutation(internal.shopCatalog.setDigitalInternal, {
      issueId,
      status,
      shopUrl: url,
      auditAction: "issue.shopOffer",
    });
    return status;
  },
});

/** Digital-Variante im Laden zuruecknehmen. Freischaltungen bleiben. */
export const withdraw = action({
  args: { issueId: v.id("issues") },
  returns: digitalStatus,
  handler: async (ctx, { issueId }): Promise<DigitalStatus> => {
    await ctx.runQuery(internal.shopCatalog.requireAdminInternal, {});
    const c: IssueContext = await ctx.runQuery(internal.shopCatalog.contextInternal, {
      issueId,
    });
    if (!c.shopProductId || !c.externalSku) {
      throw new Error("Diese Ausgabe ist im Shop nicht angeboten.");
    }
    await shop("withdraw_digital", { id_product: c.shopProductId, sku: c.externalSku });
    // Kaufknopf zurueck auf die Produktseite; scheitert das, bleibt die alte.
    let productUrl: string | undefined;
    try {
      productUrl = parseProduct((await callShopApi("product", { id: c.shopProductId })).product)?.url;
    } catch {
      productUrl = undefined;
    }
    const status: DigitalStatus = { offered: false, sku: c.externalSku, syncedAt: Date.now() };
    await ctx.runMutation(internal.shopCatalog.setDigitalInternal, {
      issueId,
      status,
      shopUrl: productUrl,
      auditAction: "issue.shopWithdraw",
    });
    return status;
  },
});

/** Stand der Digital-Variante aus dem Laden neu holen. */
export const refresh = action({
  args: { issueId: v.id("issues") },
  returns: digitalStatus,
  handler: async (ctx, { issueId }): Promise<DigitalStatus> => {
    await ctx.runQuery(internal.shopCatalog.requireAdminInternal, {});
    const c: IssueContext = await ctx.runQuery(internal.shopCatalog.contextInternal, {
      issueId,
    });
    if (!c.shopProductId) throw new Error("Erst das Druckheft im Shop auswählen.");
    const product = parseProduct((await shop("product", { id: c.shopProductId })).product);
    if (!product) throw new Error("Der Shop lieferte kein gültiges Produkt.");
    const status: DigitalStatus = statusFrom(product);
    await ctx.runMutation(internal.shopCatalog.setDigitalInternal, { issueId, status });
    return status;
  },
});

export type ShopCatalogProduct = Product;
