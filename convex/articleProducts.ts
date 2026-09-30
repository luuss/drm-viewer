import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  MutationCtx,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hasIssueAccess } from "./access";
import { requireEditor, audit } from "./roles";
import { SHOP_URL } from "./shopCovers";
import {
  ShopApiError,
  ShopProduct,
  callShopApi,
  parseProduct,
  parseProducts,
} from "./shopApi";
import {
  Hint,
  blockKey,
  findHints,
  isShopUrl,
  pickByReference,
  pickByTitle,
  tokens,
} from "./articleProductRules";

/**
 * Buchanzeigen im Heft mit dem Produkt im Laden verbinden.
 *
 * Nach jedem Import liest `matchInternal` die Anzeigen aus den Artikeltexten
 * (Regeln in articleProductRules.ts), fragt den Laden ueber die signierte
 * Schnittstelle und legt je Anzeigenabsatz eine Zeile in `articleProducts` ab.
 * Der Leser zeigt daraus den Bestellknopf im Artikel und die Auswahl
 * "bestellen oder lesen" im Seitenmodus. Die Redaktion muss nichts tun, kann
 * aber je Absatz ein Produkt setzen oder entfernen; diese Entscheidung liegt
 * in `productOverrides` und ueberlebt einen neuen Import.
 *
 * Adressen kommen nur aus der Antwort des Ladens, nie aus dem Hefttext. Ein
 * naechtlicher Lauf fuehrt Preis, Adresse und Verfuegbarkeit nach und versucht
 * offene Anzeigen juengerer Hefte erneut (das Buch steht oft erst nach dem
 * Heft im Laden).
 *
 * Standard-Laufzeitsystem, kein "use node".
 */

/** Bis zu dieser Textlaenge gilt ein Artikel mit Produkt als Anzeige. */
export const AD_MAX_CHARS = 3000;
const MAX_LINKS_PER_ISSUE = 500;
const MAX_OVERRIDES = 2000;
const MAX_PRODUCTS_PER_BLOCK = 12;
/** Ab so vielen Woertern ist ein Absatz eindeutig genug fuer eine dauerhafte Korrektur. */
const MIN_OVERRIDE_WORDS = 4;
/** Ein von Hand ergaenztes Produkt haengt am letzten Absatz dieser Laenge. */
const MIN_ANCHOR_CHARS = 60;
/** Wiederholung, wenn der Laden beim Abgleich nicht antwortet. */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000];
/** Naechtlicher Lauf: so viele Produkte je Nacht, aelteste Pruefung zuerst. */
const REFRESH_BATCH = 200;
const REFRESH_MIN_AGE_MS = 20 * 3_600_000;
/** So lange nach dem Import werden offene Anzeigen nachts erneut versucht. */
const RETRY_WINDOW_MS = 60 * 24 * 3_600_000;
const RETRY_ISSUES_PER_NIGHT = 10;

const linkSource = v.union(v.literal("number"), v.literal("title"), v.literal("editor"));

const linkInput = v.object({
  blockId: v.id("articleBlocks"),
  source: linkSource,
  reference: v.optional(v.string()),
  productId: v.optional(v.number()),
  label: v.optional(v.string()),
  note: v.optional(v.string()),
});

const productInput = v.object({
  productId: v.number(),
  reference: v.string(),
  name: v.string(),
  url: v.string(),
  priceCents: v.optional(v.number()),
  active: v.boolean(),
});

type LinkInput = {
  blockId: Id<"articleBlocks">;
  source: "number" | "title" | "editor";
  reference?: string;
  productId?: number;
  label?: string;
  note?: string;
};
type ProductInput = {
  productId: number;
  reference: string;
  name: string;
  url: string;
  priceCents?: number;
  active: boolean;
};

export type MatchPlan = {
  /** Erkannte Anzeigen, in Lesereihenfolge. */
  hints: (Hint & { blockId: Id<"articleBlocks"> })[];
  /** Absaetze, fuer die die Redaktion entschieden hat. */
  fixed: { blockId: Id<"articleBlocks">; productIds: number[] }[];
};

/** Zugriff auf den Laden; austauschbar, damit der Abgleich ohne Laden testbar ist. */
export type ShopLookup = {
  search: (q: string) => Promise<ShopProduct[]>;
  product: (id: number) => Promise<ShopProduct | null>;
};

function toInput(p: ShopProduct): ProductInput {
  return {
    productId: p.id,
    reference: p.reference,
    name: p.name,
    url: p.url,
    priceCents: p.priceCents ?? undefined,
    active: p.active,
  };
}

const excerpt = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);

const shopLookup: ShopLookup = {
  search: async (q) =>
    parseProducts(await callShopApi("search", { q })).filter((p) => isShopUrl(p.url)),
  product: async (id) => {
    try {
      const p = parseProduct((await callShopApi("product", { id })).product);
      return p && isShopUrl(p.url) ? p : null;
    } catch (error) {
      if (error instanceof ShopApiError && error.code === "product_not_found") return null;
      throw error;
    }
  },
};

/**
 * Den Plan gegen den Laden aufloesen. Jede Suche laeuft je Lauf nur einmal;
 * ein Fehler des Ladens bricht den ganzen Lauf ab, damit kein halber Stand
 * gespeichert wird.
 */
export async function resolvePlan(
  plan: MatchPlan,
  shop: ShopLookup,
): Promise<{ links: LinkInput[]; products: ProductInput[] }> {
  const searches = new Map<string, ShopProduct[]>();
  const search = async (q: string) => {
    let hit = searches.get(q);
    if (!hit) {
      hit = await shop.search(q);
      searches.set(q, hit);
    }
    return hit;
  };
  const products = new Map<number, ShopProduct>();
  const links: LinkInput[] = [];
  const taken = new Set<string>();
  const link = (entry: LinkInput, product?: ShopProduct) => {
    if (product) {
      // Dasselbe Produkt zweimal im selben Absatz waere zweimal derselbe Knopf.
      const key = `${entry.blockId}:${product.id}`;
      if (taken.has(key)) return;
      taken.add(key);
      products.set(product.id, product);
      links.push({ ...entry, productId: product.id });
    } else {
      links.push(entry);
    }
  };

  for (const fix of plan.fixed) {
    if (fix.productIds.length === 0) {
      link({ blockId: fix.blockId, source: "editor", note: "Von der Redaktion ohne Produkt gelassen" });
    }
    for (const id of fix.productIds) {
      const product = products.get(id) ?? (await shop.product(id));
      if (product) link({ blockId: fix.blockId, source: "editor" }, product);
      else {
        link({
          blockId: fix.blockId,
          source: "editor",
          note: `Produkt ${id} gibt es im Netzladen nicht mehr`,
        });
      }
    }
  }

  for (const hint of plan.hints) {
    if (hint.kind === "number") {
      const entry: LinkInput = {
        blockId: hint.blockId,
        source: "number",
        reference: hint.reference,
        label: `Art. ${hint.reference}`,
      };
      const product = pickByReference(await search(hint.reference), hint.reference);
      if (product) link(entry, product);
      else link({ ...entry, note: "Artikelnummer im Netzladen nicht gefunden" });
      continue;
    }
    const entry: LinkInput = {
      blockId: hint.blockId,
      source: "title",
      label: excerpt(hint.zone) || undefined,
    };
    const candidates = new Map<number, ShopProduct>();
    for (const q of hint.queries) {
      for (const p of await search(q)) candidates.set(p.id, p);
    }
    const product = pickByTitle([...candidates.values()], hint);
    if (product) link(entry, product);
    else {
      link({
        ...entry,
        note:
          hint.queries.length === 0
            ? "Kein Titel im Anzeigentext"
            : candidates.size === 0
              ? "Im Netzladen nicht gefunden"
              : "Kein eindeutiger Treffer im Netzladen",
      });
    }
  }
  return { links, products: [...products.values()].map(toInput) };
}

async function upsertProduct(ctx: MutationCtx, p: ProductInput) {
  const existing = await ctx.db
    .query("shopProducts")
    .withIndex("by_product", (q) => q.eq("productId", p.productId))
    .first();
  const fields = { ...p, checkedAt: Date.now() };
  if (existing) await ctx.db.replace(existing._id, fields);
  else await ctx.db.insert("shopProducts", fields);
}

/** Verknuepfungen eines Absatzes entfernen (der Absatz wird geloescht). */
export async function deleteLinksForBlock(ctx: MutationCtx, blockId: Id<"articleBlocks">) {
  const rows = await ctx.db
    .query("articleProducts")
    .withIndex("by_block", (q) => q.eq("blockId", blockId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/** Alle Verknuepfungen einer Ausgabe entfernen (neuer Import, Ausgabe geloescht). */
export async function deleteLinksForIssue(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("articleProducts")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

// --- Abgleich -----------------------------------------------------------------

export const planInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }): Promise<MatchPlan | null> => {
    if (!(await ctx.db.get(issueId))) return null;
    const overrides = await ctx.db.query("productOverrides").take(MAX_OVERRIDES);
    const decided = new Map(overrides.map((o) => [o.key, o.productIds]));
    const articles = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();

    const plan: MatchPlan = { hints: [], fixed: [] };
    for (const article of articles) {
      const blocks = (
        await ctx.db
          .query("articleBlocks")
          .withIndex("by_article_order", (q) => q.eq("articleId", article._id))
          .collect()
      ).filter((b) => b.type !== "table");

      const overridden = new Set<Id<"articleBlocks">>();
      if (decided.size > 0) {
        for (const b of blocks) {
          const productIds = decided.get(blockKey(b.text));
          if (!productIds) continue;
          overridden.add(b._id);
          plan.fixed.push({ blockId: b._id, productIds });
        }
      }
      // Die Regeln bekommen die Stelle in der Liste statt `order`: nach
      // Eingriffen der Redaktion ist `order` nicht mehr lueckenlos.
      const hints = findHints({
        title: article.title,
        blocks: blocks.map((b, i) => ({ order: i, text: b.text })),
      });
      for (const hint of hints) {
        const block = blocks[hint.blockOrder];
        if (overridden.has(block._id)) continue;
        plan.hints.push({ ...hint, blockId: block._id });
      }
    }
    return plan;
  },
});

export const storeInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    links: v.array(linkInput),
    products: v.array(productInput),
  },
  handler: async (ctx, { issueId, links, products }) => {
    const old = await ctx.db
      .query("articleProducts")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    // Hat die Redaktion waehrend des Laufs einen Absatz entschieden, kennt der
    // Plan das noch nicht. Ihre Zeilen bleiben dann stehen.
    const planned = new Set(links.filter((l) => l.source === "editor").map((l) => l.blockId));
    const kept = new Set<Id<"articleBlocks">>();
    for (const row of old) {
      if (row.source === "editor" && !planned.has(row.blockId)) kept.add(row.blockId);
      else await ctx.db.delete(row._id);
    }

    let linked = 0;
    let open = 0;
    for (const [order, l] of links.entries()) {
      if (kept.has(l.blockId)) continue;
      // Ein neuer Import waehrend des Laufs hat die Absaetze ersetzt; sein
      // eigener Abgleich folgt.
      const block = await ctx.db.get(l.blockId);
      if (!block || block.issueId !== issueId) continue;
      await ctx.db.insert("articleProducts", { issueId, order, ...l });
      if (l.productId !== undefined) linked++;
      else if (l.source !== "editor") open++;
    }
    for (const p of products) await upsertProduct(ctx, p);
    return { linked, open };
  },
});

/**
 * Anzeigen einer Ausgabe erkennen und zuordnen. Laeuft nach jedem Import, auf
 * Knopfdruck der Redaktion und nachts fuer Hefte mit offenen Anzeigen.
 */
export const matchInternal = internalAction({
  args: { issueId: v.id("issues"), attempt: v.optional(v.number()) },
  handler: async (ctx, { issueId, attempt }): Promise<{ linked: number; open: number } | null> => {
    if (!process.env.SHOP_WEBHOOK_SECRET) {
      console.log("articleProducts: SHOP_WEBHOOK_SECRET fehlt, kein Abgleich mit dem Laden");
      return null;
    }
    const plan: MatchPlan | null = await ctx.runQuery(internal.articleProducts.planInternal, {
      issueId,
    });
    if (!plan) return null;

    let resolved: Awaited<ReturnType<typeof resolvePlan>>;
    try {
      resolved = await resolvePlan(plan, shopLookup);
    } catch (error) {
      if (!(error instanceof ShopApiError)) throw error;
      // Der alte Stand bleibt stehen; spaeter noch einmal.
      const n = attempt ?? 0;
      if (n < RETRY_DELAYS_MS.length) {
        await ctx.scheduler.runAfter(RETRY_DELAYS_MS[n], internal.articleProducts.matchInternal, {
          issueId,
          attempt: n + 1,
        });
      }
      console.error(
        JSON.stringify({ event: "articleProducts.shopFailed", issueId, attempt: n, error: error.message }),
      );
      return null;
    }
    const stored: { linked: number; open: number } = await ctx.runMutation(
      internal.articleProducts.storeInternal,
      { issueId, links: resolved.links, products: resolved.products },
    );
    console.log(JSON.stringify({ event: "articleProducts.matched", issueId, ...stored }));
    return stored;
  },
});

// --- naechtlicher Lauf --------------------------------------------------------

export const staleProductsInternal = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, { before, limit }) => {
    const rows = await ctx.db
      .query("shopProducts")
      .withIndex("by_checked", (q) => q.lt("checkedAt", before))
      .take(limit);
    return rows.map((r) => r.productId);
  },
});

export const saveProductsInternal = internalMutation({
  args: { products: v.array(productInput), gone: v.array(v.number()) },
  handler: async (ctx, { products, gone }) => {
    for (const p of products) {
      // Zeigt keine Anzeige mehr auf das Produkt, braucht es auch keiner mehr.
      const used = await ctx.db
        .query("articleProducts")
        .withIndex("by_product", (q) => q.eq("productId", p.productId))
        .first();
      if (used) {
        await upsertProduct(ctx, p);
        continue;
      }
      const row = await ctx.db
        .query("shopProducts")
        .withIndex("by_product", (q) => q.eq("productId", p.productId))
        .first();
      if (row) await ctx.db.delete(row._id);
    }
    for (const productId of gone) {
      const row = await ctx.db
        .query("shopProducts")
        .withIndex("by_product", (q) => q.eq("productId", productId))
        .first();
      if (row) await ctx.db.patch(row._id, { active: false, checkedAt: Date.now() });
    }
    return null;
  },
});

export const issuesWithOpenHintsInternal = internalQuery({
  args: { since: v.number(), limit: v.number() },
  handler: async (ctx, { since, limit }) => {
    const open = await ctx.db
      .query("articleProducts")
      .withIndex("by_product", (q) => q.eq("productId", undefined))
      .take(MAX_OVERRIDES);
    const issueIds = new Set<Id<"issues">>();
    for (const row of open) {
      if (row.source !== "editor") issueIds.add(row.issueId);
    }
    const out: Id<"issues">[] = [];
    for (const issueId of issueIds) {
      const issue = await ctx.db.get(issueId);
      if (issue && issue.createdAt >= since) out.push(issueId);
      if (out.length >= limit) break;
    }
    return out;
  },
});

/** Naechtlich: Preis, Adresse und Verfuegbarkeit nachfuehren, offene Anzeigen erneut versuchen. */
export const refreshInternal = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; gone: number; retried: number }> => {
    if (!process.env.SHOP_WEBHOOK_SECRET) return { checked: 0, gone: 0, retried: 0 };
    const now = Date.now();
    const ids: number[] = await ctx.runQuery(internal.articleProducts.staleProductsInternal, {
      before: now - REFRESH_MIN_AGE_MS,
      limit: REFRESH_BATCH,
    });
    const products: ProductInput[] = [];
    const gone: number[] = [];
    try {
      for (const id of ids) {
        const product = await shopLookup.product(id);
        if (product) products.push(toInput(product));
        else gone.push(id);
      }
    } catch (error) {
      if (!(error instanceof ShopApiError)) throw error;
      // Laden nicht erreichbar: was bis hierhin gelesen ist, wird gespeichert,
      // der Rest kommt in der naechsten Nacht.
      console.error(JSON.stringify({ event: "articleProducts.refreshFailed", error: error.message }));
    }
    await ctx.runMutation(internal.articleProducts.saveProductsInternal, { products, gone });

    const retry: Id<"issues">[] = await ctx.runQuery(
      internal.articleProducts.issuesWithOpenHintsInternal,
      { since: now - RETRY_WINDOW_MS, limit: RETRY_ISSUES_PER_NIGHT },
    );
    for (const issueId of retry) {
      await ctx.scheduler.runAfter(0, internal.articleProducts.matchInternal, { issueId });
    }
    return { checked: products.length, gone: gone.length, retried: retry.length };
  },
});

// --- Leser ----------------------------------------------------------------------

/**
 * Bestellbare Produkte je Artikel. `isAd` sagt dem Seitenmodus, ob ein Tipp
 * auf den Artikel erst die Auswahl "bestellen oder lesen" zeigt: nur bei
 * kurzen Texten, also Anzeigen und Besprechungen. In einem langen Artikel
 * steht der Knopf nur an seiner Stelle im Text.
 *
 * Fuehrt der Laden das Buch einer erkannten Anzeige nicht (nicht gefunden,
 * nicht eindeutig, inzwischen herausgenommen), bekommt der Artikel einen
 * Eintrag ohne `productId`: der Knopf fuehrt auf die Startseite des Ladens.
 * Hat die Redaktion den Absatz ausdruecklich ohne Produkt gelassen, gibt es
 * keinen Knopf.
 */
export const forReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const rows = await ctx.db
      .query("articleProducts")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .take(MAX_LINKS_PER_ISSUE);

    type Entry = {
      articleId: Id<"articles">;
      isAd: boolean;
      products: {
        productId: number | null;
        name: string;
        url: string;
        priceCents: number | null;
        blockOrder: number;
        order: number;
      }[];
    };
    const articles = new Map<Id<"articles">, Entry | null>();
    const products = new Map<number, Doc<"shopProducts"> | null>();
    for (const row of rows) {
      if (row.productId === undefined && row.source === "editor") continue;
      const block = await ctx.db.get(row.blockId);
      if (!block) continue;
      if (!articles.has(block.articleId)) {
        const article = await ctx.db.get(block.articleId);
        articles.set(
          block.articleId,
          article?.reviewStatus === "approved"
            ? {
                articleId: article._id,
                isAd: article.searchText.length <= AD_MAX_CHARS,
                products: [],
              }
            : null,
        );
      }
      const entry = articles.get(block.articleId);
      if (!entry) continue;
      if (row.productId !== undefined && !products.has(row.productId)) {
        products.set(
          row.productId,
          await ctx.db
            .query("shopProducts")
            .withIndex("by_product", (q) => q.eq("productId", row.productId!))
            .first(),
        );
      }
      const product = row.productId === undefined ? null : products.get(row.productId);
      if (!product || !product.active || !isShopUrl(product.url)) {
        // Je Artikel hoechstens ein Knopf zur Startseite.
        if (entry.products.some((p) => p.productId === null)) continue;
        entry.products.push({
          productId: null,
          name: "",
          url: `${SHOP_URL}/`,
          priceCents: null,
          blockOrder: block.order,
          order: row.order,
        });
        continue;
      }
      if (entry.products.some((p) => p.productId === product.productId)) continue;
      entry.products.push({
        productId: product.productId,
        name: product.name,
        url: product.url,
        priceCents: product.priceCents ?? null,
        blockOrder: block.order,
        order: row.order,
      });
    }
    return [...articles.values()]
      .filter((entry): entry is Entry => entry !== null && entry.products.length > 0)
      .map((entry) => ({
        articleId: entry.articleId,
        isAd: entry.isAd,
        products: entry.products
          .sort((a, b) => a.blockOrder - b.blockOrder || a.order - b.order)
          .map(({ order: _order, ...rest }) => rest),
      }));
  },
});

// --- Redaktion ------------------------------------------------------------------

export const requireEditorInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireEditor(ctx);
    return true;
  },
});

/** Erkannte Anzeigen und ihre Produkte, fuer die Pruefansicht. */
export const listForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("articleProducts")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .take(MAX_LINKS_PER_ISSUE);
    const out = [];
    const articleOrder = new Map<Id<"articles">, number>();
    for (const row of rows) {
      const block = await ctx.db.get(row.blockId);
      if (!block) continue;
      if (!articleOrder.has(block.articleId)) {
        articleOrder.set(block.articleId, (await ctx.db.get(block.articleId))?.order ?? 0);
      }
      const product =
        row.productId === undefined
          ? null
          : await ctx.db
              .query("shopProducts")
              .withIndex("by_product", (q) => q.eq("productId", row.productId!))
              .first();
      out.push({
        _id: row._id,
        articleId: block.articleId,
        articleOrder: articleOrder.get(block.articleId) ?? 0,
        blockId: row.blockId,
        blockOrder: block.order,
        order: row.order,
        source: row.source,
        reference: row.reference ?? null,
        label: row.label ?? excerpt(block.text),
        note: row.note ?? null,
        product: product
          ? {
              productId: product.productId,
              name: product.name,
              reference: product.reference,
              url: product.url,
              priceCents: product.priceCents ?? null,
              active: product.active,
            }
          : null,
      });
    }
    return out.sort(
      (a, b) =>
        a.articleOrder - b.articleOrder || a.blockOrder - b.blockOrder || a.order - b.order,
    );
  },
});

/** Produkte im Laden suchen: Titel, Verfasser, Artikelnummer oder Produktadresse. */
export const searchShop = action({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    await ctx.runQuery(internal.articleProducts.requireEditorInternal, {});
    const text = q.trim().slice(0, 300);
    if (!text) return [];
    let found: ShopProduct[];
    try {
      // Eine eingefuegte Produktadresse traegt die Produktnummer vor dem Namen.
      const fromUrl = isShopUrl(text) ? /\/(\d+)-[^/]*$/.exec(new URL(text).pathname) : null;
      if (fromUrl) {
        const product = await shopLookup.product(Number(fromUrl[1]));
        found = product ? [product] : [];
      } else {
        found = await shopLookup.search(text.replace(/[^\p{L}\p{N}-]+/gu, " ").trim());
      }
    } catch (error) {
      if (error instanceof ShopApiError) throw new Error(error.message);
      throw error;
    }
    return found.slice(0, 20).map((p) => ({
      productId: p.id,
      name: p.name,
      reference: p.reference,
      manufacturer: p.manufacturer,
      url: p.url,
      priceCents: p.priceCents,
      active: p.active,
    }));
  },
});

/**
 * Entscheidung der Redaktion fuer einen Absatz festschreiben: die Zeilen des
 * Absatzes ersetzen und, wenn der Text eindeutig genug ist, die Entscheidung
 * unter seinem Schluessel ablegen.
 */
async function decideBlock(
  ctx: MutationCtx,
  block: Doc<"articleBlocks">,
  productIds: number[],
) {
  await deleteLinksForBlock(ctx, block._id);
  if (productIds.length === 0) {
    await ctx.db.insert("articleProducts", {
      issueId: block.issueId,
      blockId: block._id,
      order: 0,
      source: "editor",
      note: "Von der Redaktion ohne Produkt gelassen",
    });
  }
  for (const [order, productId] of productIds.entries()) {
    await ctx.db.insert("articleProducts", {
      issueId: block.issueId,
      blockId: block._id,
      order,
      source: "editor",
      productId,
    });
  }
  if (tokens(block.text).length >= MIN_OVERRIDE_WORDS) {
    const key = blockKey(block.text);
    const userId = await getAuthUserId(ctx);
    const fields = {
      key,
      productIds,
      excerpt: excerpt(block.text),
      updatedByUserId: (userId as Id<"users"> | null) ?? undefined,
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("productOverrides")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("productOverrides", fields);
  }
  await audit(
    ctx,
    "article.products",
    block.issueId,
    `${block.articleId}: ${productIds.join(", ") || "kein Produkt"}`,
  );
}

async function linkedProductIds(ctx: MutationCtx, blockId: Id<"articleBlocks">) {
  const rows = await ctx.db
    .query("articleProducts")
    .withIndex("by_block", (q) => q.eq("blockId", blockId))
    .collect();
  return rows
    .sort((a, b) => a.order - b.order)
    .flatMap((r) => (r.productId === undefined ? [] : [r.productId]));
}

export const addInternal = internalMutation({
  args: {
    articleId: v.id("articles"),
    blockId: v.optional(v.id("articleBlocks")),
    product: productInput,
  },
  handler: async (ctx, { articleId, blockId, product }) => {
    await requireEditor(ctx);
    let block = blockId ? await ctx.db.get(blockId) : null;
    if (!block) {
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
        .collect();
      block =
        [...blocks].reverse().find((b) => b.text.trim().length >= MIN_ANCHOR_CHARS) ??
        blocks[blocks.length - 1] ??
        null;
    }
    if (!block || block.articleId !== articleId) throw new Error("Absatz nicht gefunden");
    const current = await linkedProductIds(ctx, block._id);
    if (current.includes(product.productId)) return null;
    if (current.length >= MAX_PRODUCTS_PER_BLOCK) {
      throw new Error("Zu viele Produkte an einem Absatz");
    }
    await upsertProduct(ctx, product);
    await decideBlock(ctx, block, [...current, product.productId]);
    return null;
  },
});

/**
 * Produkt an einen Artikel haengen. Mit `blockId` an diesen Absatz (eine
 * erkannte, aber offene Anzeige), sonst an den letzten laengeren Absatz.
 */
export const addProduct = action({
  args: {
    articleId: v.id("articles"),
    blockId: v.optional(v.id("articleBlocks")),
    productId: v.number(),
  },
  handler: async (ctx, { articleId, blockId, productId }) => {
    await ctx.runQuery(internal.articleProducts.requireEditorInternal, {});
    if (!Number.isInteger(productId) || productId <= 0) throw new Error("Ungültige Produktnummer");
    let product: ShopProduct | null;
    try {
      product = await shopLookup.product(productId);
    } catch (error) {
      if (error instanceof ShopApiError) throw new Error(error.message);
      throw error;
    }
    if (!product) throw new Error("Dieses Produkt gibt es im Netzladen nicht.");
    await ctx.runMutation(internal.articleProducts.addInternal, {
      articleId,
      blockId,
      product: toInput(product),
    });
    return null;
  },
});

/** Eine Verknuepfung entfernen. Die uebrigen Produkte des Absatzes bleiben. */
export const removeLink = mutation({
  args: { linkId: v.id("articleProducts") },
  handler: async (ctx, { linkId }) => {
    await requireEditor(ctx);
    const row = await ctx.db.get(linkId);
    if (!row) return null;
    const block = await ctx.db.get(row.blockId);
    if (!block) {
      await ctx.db.delete(linkId);
      return null;
    }
    const rest = (await linkedProductIds(ctx, block._id)).filter((id) => id !== row.productId);
    await decideBlock(ctx, block, rest);
    return null;
  },
});

/** Entscheidung der Redaktion fuer einen Absatz zuruecknehmen: wieder automatisch. */
export const resetBlock = mutation({
  args: { blockId: v.id("articleBlocks") },
  handler: async (ctx, { blockId }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) return null;
    const override = await ctx.db
      .query("productOverrides")
      .withIndex("by_key", (q) => q.eq("key", blockKey(block.text)))
      .first();
    if (override) await ctx.db.delete(override._id);
    await deleteLinksForBlock(ctx, blockId);
    await audit(ctx, "article.products", block.issueId, `${block.articleId}: automatisch`);
    await ctx.scheduler.runAfter(0, internal.articleProducts.matchInternal, {
      issueId: block.issueId,
    });
    return null;
  },
});

/** Abgleich mit dem Laden von Hand anstossen — der Knopf in der Pruefansicht. */
export const rematch = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    await ctx.scheduler.runAfter(0, internal.articleProducts.matchInternal, { issueId });
    return null;
  },
});
