import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { MatchPlan, ShopLookup, resolvePlan } from "./articleProducts";
import { ShopApiError, ShopProduct } from "./shopApi";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "gemeinsames-geheimnis";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Antworten des Ladens im Format der Schnittstelle.
const GENERALE = {
  id: 10623,
  name: "Die Generale der Waffen-SS",
  reference: "101208",
  price_gross: 29.8,
  url: "https://lesenundschenken.de/10623-die-generale-der-waffen-ss.html",
  cover_url: null,
  manufacturer: "Nikolaus von Preradovich",
  active: true,
  digital: null,
};
const THESEN = {
  id: 2590,
  name: "80 Thesen zur Vertreibung",
  reference: "271165",
  price_gross: 17.9,
  url: "https://lesenundschenken.de/2590-80-thesen-zur-vertreibung.html",
  cover_url: null,
  manufacturer: "Alfred de Zayas/Konrad Badenheuer",
  active: true,
  digital: null,
};
const POLNISCH = {
  id: 4021,
  name: "Der Tod sprach polnisch",
  reference: "111544",
  price_gross: 32.8,
  url: "https://lesenundschenken.de/4021-der-tod-sprach-polnisch.html",
  cover_url: null,
  manufacturer: "",
  active: true,
  digital: null,
};
const CATALOG = [GENERALE, THESEN, POLNISCH];

/** Laden nachstellen: Suche ueber Name, Referenz und Hersteller, jedes Wort muss vorkommen. */
function stubShop(catalog: any[] = CATALOG) {
  const calls: any[] = [];
  vi.stubEnv("SHOP_WEBHOOK_SECRET", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (body.action === "product") {
        const product = catalog.find((p) => p.id === body.id);
        return product
          ? json({ ok: true, product })
          : json({ ok: false, error: "product_not_found", message: "Produkt nicht gefunden" }, 404);
      }
      const words = String(body.q).toLowerCase().split(/\s+/);
      const products = catalog.filter((p) => {
        const hay = `${p.name} ${p.reference} ${p.manufacturer}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      return json({ ok: true, products });
    }),
  );
  return calls;
}

const AD_NUMBER = [
  "Nikolaus v. Preradovich",
  "Die Generale der Waffen‑SS",
  "Rund 100 dieser Männer stellt das vorliegende Nachschlagewerk in Text und Bild in Einzelbiographien vor. Die aufwendig zusammengetragenen Daten dafür stammen aus den Akten des SS‑Personalamtes. 304 S., viele s/w. Porträtfotos, geb. im Großformat.",
  "Art. 101208 t 29,80",
];
const AD_TITLE = [
  "Alfred de Zayas/",
  "Konrad Badenheuer",
  "80 Thesen zur Vertreibung",
  "Aufarbeiten statt verdrängen. – Die Vertreibung von 14 Millionen Ostdeutschen nach 1945 ist eine Zäsur der deutschen Geschichte und hat die Landkarte Europas verändert. Und doch ist es still geworden um dieses Ereignis. 216 S., s/w. Abb., Pb., € 17,90.",
];
const AD_UNTITLED = [
  "Nachdem ein Gericht die Vernichtung der Restauflage des Buches „Dokumente polnischer Grausamkeiten“ angeordnet hatte, hat der herausgebende Verlag das traurige Thema polnischer Verbrechen an Deutschen fortgeschrieben. Neben den polnischen Übergriffen seit 1919 nehmen die Vertreibungsverbrechen breiten Raum ein. 384 S., viele Abb., geb. im Großformat.",
];
const EDITORIAL = [
  "Verrat an der Truppe",
  "Immer wieder schwächen Korruptionsfälle die Schlagkraft der Streitkräfte. Der Bericht umfaßt 300 Seiten, die das Ministerium bis heute unter Verschluß hält.",
];

function articleInput(order: number, texts: string[]) {
  return {
    order,
    // Wie der Worker: ein Artikel ohne Ueberschrift heisst nach seinem Anfang.
    title: texts[0].length > 60 ? `${texts[0].slice(0, 60)} …` : texts[0],
    source: "idml" as const,
    primaryPageIndex: order,
    pageStart: order,
    pageEnd: order,
    blocks: texts.map((text, i) => ({
      order: i + 1,
      type: "paragraph" as const,
      text,
      sourcePageIndex: order,
    })),
    regions: [{ pageIndex: order, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5, kind: "body" as const }],
  };
}

async function setup(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "DMZ-Zeitgeschichte",
      slug: "dmz-zeitgeschichte",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "DMZ-Zeitgeschichte 80",
      slug: "dmz-zg-80",
      pageCount: 8,
      priceAmountCents: 1080,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const editorId = await ctx.db.insert("users", { email: "redaktion@example.de", roles: ["editor"] });
    const readerId = await ctx.db.insert("users", { email: "leser@example.de" });
    await ctx.db.insert("entitlements", { userId: readerId, issueId, source: "purchase", createdAt: now });
    const strangerId = await ctx.db.insert("users", { email: "fremd@example.de" });
    return { issueId, editorId, readerId, strangerId };
  });
}

/** Heft importieren wie der Worker; der Abgleich laeuft wie im Betrieb hinterher. */
async function importIssue(t: any, issueId: Id<"issues">, articles: string[][]) {
  const jobId = await t.run(async (ctx: any) =>
    ctx.db.insert("importJobs", {
      issueId,
      kind: "full",
      status: "running",
      attempts: 1,
      workerId: "w1",
      createdAt: Date.now(),
    }),
  );
  await t.mutation(internal.imports.activateResultInternal, {
    jobId,
    workerId: "w1",
    issueId,
    articles: articles.map((texts, i) => articleInput(i + 1, texts)),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function approveAll(t: any, issueId: Id<"issues">) {
  await t.run(async (ctx: any) => {
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { reviewStatus: "approved" });
  });
}

async function articleIds(t: any, issueId: Id<"issues">): Promise<Id<"articles">[]> {
  return await t.run(async (ctx: any) =>
    (
      await ctx.db
        .query("articles")
        .withIndex("by_issue_order", (q: any) => q.eq("issueId", issueId))
        .collect()
    ).map((a: any) => a._id),
  );
}

const asUser = (t: any, userId: string) => t.withIdentity({ subject: userId });

describe("Plan gegen den Laden aufloesen", () => {
  const shopProduct = (raw: typeof GENERALE): ShopProduct => ({
    id: raw.id,
    name: raw.name,
    reference: raw.reference,
    priceCents: Math.round(raw.price_gross * 100),
    url: raw.url,
    coverUrl: null,
    manufacturer: raw.manufacturer,
    active: raw.active,
    digital: null,
  });
  const block = (n: number) => `block${n}` as Id<"articleBlocks">;
  const plan: MatchPlan = {
    hints: [
      { kind: "number", blockOrder: 0, reference: "101208", blockId: block(1) },
      { kind: "number", blockOrder: 0, reference: "999999", blockId: block(2) },
      {
        kind: "title",
        blockOrder: 0,
        zone: "Alfred de Zayas/ Konrad Badenheuer 80 Thesen zur Vertreibung",
        lines: ["Alfred de Zayas/", "Konrad Badenheuer", "80 Thesen zur Vertreibung"],
        queries: ["80 Thesen zur Vertreibung", "Konrad Badenheuer"],
        priceCents: 1790,
        blockId: block(3),
      },
    ],
    fixed: [
      { blockId: block(4), productIds: [4021] },
      { blockId: block(5), productIds: [] },
    ],
  };

  test("Nummer, Titel, Entscheidung der Redaktion; jede Suche nur einmal", async () => {
    const searched: string[] = [];
    const shop: ShopLookup = {
      search: async (q) => {
        searched.push(q);
        if (q === "101208") return [shopProduct(GENERALE)];
        if (q === "80 Thesen zur Vertreibung" || q === "Konrad Badenheuer") return [shopProduct(THESEN)];
        return [];
      },
      product: async (id) => (id === 4021 ? shopProduct(POLNISCH) : null),
    };
    const twice: MatchPlan = { ...plan, hints: [...plan.hints, { ...plan.hints[0], blockId: block(6) }] };
    const { links, products } = await resolvePlan(twice, shop);
    expect(links).toEqual([
      { blockId: block(4), source: "editor", productId: 4021 },
      { blockId: block(5), source: "editor", note: "Von der Redaktion ohne Produkt gelassen" },
      { blockId: block(1), source: "number", reference: "101208", label: "Art. 101208", productId: 10623 },
      {
        blockId: block(2),
        source: "number",
        reference: "999999",
        label: "Art. 999999",
        note: "Artikelnummer im Netzladen nicht gefunden",
      },
      {
        blockId: block(3),
        source: "title",
        label: "Alfred de Zayas/ Konrad Badenheuer 80 Thesen zur Vertreibung",
        productId: 2590,
      },
      { blockId: block(6), source: "number", reference: "101208", label: "Art. 101208", productId: 10623 },
    ]);
    expect(products.map((p) => p.productId).sort((a, b) => a - b)).toEqual([2590, 4021, 10623]);
    expect(searched.filter((q) => q === "101208")).toHaveLength(1);
  });

  test("Fehler des Ladens bricht den Lauf ab, statt einen halben Stand zu liefern", async () => {
    const shop: ShopLookup = {
      search: async () => {
        throw new ShopApiError("Shop nicht erreichbar");
      },
      product: async () => null,
    };
    await expect(resolvePlan(plan, shop)).rejects.toThrow(ShopApiError);
  });

  test("Produkt mit fremder Adresse wird nicht verlinkt", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, readerId } = await setup(t);
    stubShop([{ ...GENERALE, url: "https://boese.example.com/10623-x.html" }]);
    await importIssue(t, issueId, [AD_NUMBER]);
    await approveAll(t, issueId);
    expect(await asUser(t, readerId).query(api.articleProducts.forReader, { issueId })).toEqual([]);
  });
});

describe("Abgleich nach dem Import", () => {
  test("Anzeigen bekommen ihr Produkt, der Leser sieht nur freigegebene Artikel", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, readerId, strangerId, editorId } = await setup(t);
    const calls = stubShop();
    await importIssue(t, issueId, [AD_NUMBER, AD_TITLE, AD_UNTITLED, EDITORIAL]);

    const rows = await asUser(t, editorId).query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => [r.source, r.product?.productId ?? null, r.note])).toEqual([
      ["number", 10623, null],
      ["title", 2590, null],
      ["title", null, "Kein Titel im Anzeigentext"],
    ]);
    // Der gewoehnliche Artikel loest keine Anfrage aus.
    expect(calls.every((c) => c.action === "search")).toBe(true);
    expect(calls.map((c) => c.q)).toContain("101208");

    const reader = asUser(t, readerId);
    expect(await reader.query(api.articleProducts.forReader, { issueId })).toEqual([]);
    await approveAll(t, issueId);
    const [first, second, third] = await articleIds(t, issueId);
    const seen = await reader.query(api.articleProducts.forReader, { issueId });
    expect(seen).toEqual([
      {
        articleId: first,
        isAd: true,
        products: [
          {
            productId: 10623,
            name: "Die Generale der Waffen-SS",
            url: GENERALE.url,
            priceCents: 2980,
            blockOrder: 4,
          },
        ],
      },
      {
        articleId: second,
        isAd: true,
        products: [
          {
            productId: 2590,
            name: "80 Thesen zur Vertreibung",
            url: THESEN.url,
            priceCents: 1790,
            blockOrder: 4,
          },
        ],
      },
    ]);
    expect(seen.some((e: any) => e.articleId === third)).toBe(false);

    expect(await asUser(t, strangerId).query(api.articleProducts.forReader, { issueId })).toEqual([]);
    expect(await t.query(api.articleProducts.forReader, { issueId })).toEqual([]);
    await expect(
      asUser(t, readerId).query(api.articleProducts.listForEditors, { issueId }),
    ).rejects.toThrow();
  });

  test("langer Artikel mit Anzeige darin: Knopf im Text, aber keine Auswahl im Seitenmodus", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, readerId } = await setup(t);
    stubShop();
    const long = Array.from({ length: 8 }, (_, i) => `Absatz ${i + 1}. ${"Text des Nachrufs. ".repeat(25)}`);
    await importIssue(t, issueId, [[...long, ...AD_NUMBER]]);
    await approveAll(t, issueId);
    const seen = await asUser(t, readerId).query(api.articleProducts.forReader, { issueId });
    expect(seen).toHaveLength(1);
    expect(seen[0].isAd).toBe(false);
    expect(seen[0].products[0]).toMatchObject({ productId: 10623, blockOrder: 12 });
  });

  test("Laden nicht erreichbar: alter Stand bleibt, spaeter neuer Versuch", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_NUMBER]);
    const before = await asUser(t, editorId).query(api.articleProducts.listForEditors, { issueId });
    expect(before).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("kaputt", { status: 502 })));
    expect(await t.action(internal.articleProducts.matchInternal, { issueId })).toBeNull();
    expect(
      await asUser(t, editorId).query(api.articleProducts.listForEditors, { issueId }),
    ).toEqual(before);
    const scheduled = await t.run(async (ctx: any) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s: any) => s.state.kind === "pending" && s.args[0]?.attempt === 1)).toBe(true);
  });

  test("neuer Import ersetzt die Verknuepfungen", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_NUMBER, AD_TITLE]);
    await importIssue(t, issueId, [AD_TITLE]);
    const rows = await asUser(t, editorId).query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => r.product?.productId)).toEqual([2590]);
    const total = await t.run(async (ctx: any) => (await ctx.db.query("articleProducts").collect()).length);
    expect(total).toBe(1);
  });

  test("geloeschter Absatz nimmt seine Verknuepfung mit", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_NUMBER]);
    const editor = asUser(t, editorId);
    const [row] = await editor.query(api.articleProducts.listForEditors, { issueId });
    await editor.mutation(api.articles.deleteBlock, { blockId: row.blockId });
    expect(await editor.query(api.articleProducts.listForEditors, { issueId })).toEqual([]);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("articleProducts").collect()).length)).toBe(0);
  });
});

describe("Korrekturen der Redaktion", () => {
  test("offene Anzeige bekommt ein Produkt; die Entscheidung ueberlebt den neuen Import", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId, readerId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_UNTITLED]);
    const editor = asUser(t, editorId);
    const [open] = await editor.query(api.articleProducts.listForEditors, { issueId });
    expect(open.product).toBeNull();

    const found = await editor.action(api.articleProducts.searchShop, { q: "Tod sprach polnisch" });
    expect(found.map((p: any) => p.productId)).toEqual([4021]);
    await editor.action(api.articleProducts.addProduct, {
      articleId: open.articleId,
      blockId: open.blockId,
      productId: 4021,
    });
    let rows = await editor.query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => [r.source, r.product?.productId])).toEqual([["editor", 4021]]);

    await importIssue(t, issueId, [AD_UNTITLED]);
    rows = await editor.query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => [r.source, r.product?.productId])).toEqual([["editor", 4021]]);

    await approveAll(t, issueId);
    const seen = await asUser(t, readerId).query(api.articleProducts.forReader, { issueId });
    expect(seen[0].products.map((p: any) => p.productId)).toEqual([4021]);
  });

  test("falsche Verknuepfung entfernen bleibt entfernt; Zuruecksetzen holt die Automatik zurueck", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId, readerId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_NUMBER]);
    await approveAll(t, issueId);
    const editor = asUser(t, editorId);
    const reader = asUser(t, readerId);
    const [row] = await editor.query(api.articleProducts.listForEditors, { issueId });

    await editor.mutation(api.articleProducts.removeLink, { linkId: row._id });
    expect(await reader.query(api.articleProducts.forReader, { issueId })).toEqual([]);
    // Auch ein neuer Abgleich verlinkt nicht wieder.
    await editor.mutation(api.articleProducts.rematch, { issueId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let rows = await editor.query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => [r.source, r.product, r.note])).toEqual([
      ["editor", null, "Von der Redaktion ohne Produkt gelassen"],
    ]);

    await editor.mutation(api.articleProducts.resetBlock, { blockId: rows[0].blockId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    rows = await editor.query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => [r.source, r.product?.productId])).toEqual([["number", 10623]]);
    expect(await t.run(async (ctx: any) => (await ctx.db.query("productOverrides").collect()).length)).toBe(0);
  });

  test("Produkt an einen Artikel ohne erkannte Anzeige haengen, ueber die Produktadresse", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId, readerId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [EDITORIAL]);
    await approveAll(t, issueId);
    const editor = asUser(t, editorId);
    const [articleId] = await articleIds(t, issueId);

    const found = await editor.action(api.articleProducts.searchShop, { q: GENERALE.url });
    expect(found).toHaveLength(1);
    await editor.action(api.articleProducts.addProduct, { articleId, productId: found[0].productId });
    // Zweimal dasselbe Produkt bleibt ein Knopf.
    await editor.action(api.articleProducts.addProduct, { articleId, productId: found[0].productId });
    const seen = await asUser(t, readerId).query(api.articleProducts.forReader, { issueId });
    expect(seen[0].products).toHaveLength(1);
    expect(seen[0].products[0]).toMatchObject({ productId: 10623, blockOrder: 2 });

    await expect(
      editor.action(api.articleProducts.addProduct, { articleId, productId: 77 }),
    ).rejects.toThrow(/gibt es im Netzladen nicht/);
    await expect(
      asUser(t, readerId).action(api.articleProducts.addProduct, { articleId, productId: 10623 }),
    ).rejects.toThrow();
  });

  test("Entscheidung waehrend eines laufenden Abgleichs geht nicht verloren", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_NUMBER]);
    const editor = asUser(t, editorId);
    const [row] = await editor.query(api.articleProducts.listForEditors, { issueId });
    // Der Lauf hat seinen Plan schon gelesen, dann entscheidet die Redaktion.
    const plan = await t.query(internal.articleProducts.planInternal, { issueId });
    await editor.action(api.articleProducts.addProduct, {
      articleId: row.articleId,
      blockId: row.blockId,
      productId: 4021,
    });
    await t.mutation(internal.articleProducts.storeInternal, {
      issueId,
      links: plan!.hints.map((h: any) => ({
        blockId: h.blockId,
        source: "number" as const,
        reference: h.reference,
        productId: 10623,
      })),
      products: [],
    });
    const rows = await editor.query(api.articleProducts.listForEditors, { issueId });
    expect(rows.map((r: any) => [r.source, r.product?.productId])).toEqual([
      ["editor", 10623],
      ["editor", 4021],
    ]);
  });
});

describe("naechtlicher Lauf", () => {
  test("geloeschtes Produkt verliert den Knopf, Preis wird nachgefuehrt, offene Anzeigen neu versucht", async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers();
    const { issueId, editorId, readerId } = await setup(t);
    stubShop();
    await importIssue(t, issueId, [AD_NUMBER, AD_TITLE, AD_UNTITLED]);
    await approveAll(t, issueId);
    const reader = asUser(t, readerId);
    expect(await reader.query(api.articleProducts.forReader, { issueId })).toHaveLength(2);

    // Einen Tag spaeter: ein Produkt ist weg, das andere teurer.
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    stubShop([{ ...THESEN, price_gross: 19.9 }]);
    const result = await t.action(internal.articleProducts.refreshInternal, {});
    expect(result).toEqual({ checked: 1, gone: 1, retried: 1 });
    const seen = await reader.query(api.articleProducts.forReader, { issueId });
    expect(seen).toHaveLength(1);
    expect(seen[0].products[0]).toMatchObject({ productId: 2590, priceCents: 1990 });

    // Die Redaktion sieht das verschwundene Produkt weiterhin, als inaktiv.
    const rows = await asUser(t, editorId).query(api.articleProducts.listForEditors, { issueId });
    expect(rows.find((r: any) => r.product?.productId === 10623)?.product.active).toBe(false);
  });
});
