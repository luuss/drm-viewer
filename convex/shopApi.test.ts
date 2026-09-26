import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import {
  DEFAULT_SHOP_API_URL,
  callShopApi,
  digitalSku,
  parseProduct,
  priceToCents,
  rankProducts,
  seriesCode,
  suggestQuery,
} from "./shopApi";
import { checkShopSignature } from "./serviceAuth";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "gemeinsames-geheimnis";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Aufruf der Shop-Schnittstelle", () => {
  test("signiert den rohen Rumpf wie checkShopSignature, mit ts in Sekunden", async () => {
    const seen: { url: string; body: string; sig: string }[] = [];
    const fake = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), body: init.body, sig: init.headers["x-shop-signature"] });
      return jsonResponse({ ok: true, products: [] });
    });
    const json = await callShopApi(
      "search",
      { q: "DMZ Nr. 170" },
      { fetch: fake as any, secret: SECRET, url: "https://shop.test/api", now: () => 1_790_000_000_123 },
    );
    expect(json.ok).toBe(true);
    expect(seen[0].url).toBe("https://shop.test/api");
    expect(JSON.parse(seen[0].body)).toEqual({ action: "search", ts: 1_790_000_000, q: "DMZ Nr. 170" });
    vi.stubEnv("SHOP_WEBHOOK_SECRET", SECRET);
    expect(await checkShopSignature(seen[0].body, seen[0].sig)).toBe(true);
    expect(await checkShopSignature(seen[0].body + " ", seen[0].sig)).toBe(false);
  });

  test("Standardadresse und Geheimnis aus der Umgebung", async () => {
    vi.stubEnv("SHOP_WEBHOOK_SECRET", SECRET);
    const fake = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ ok: true }));
    await callShopApi("product", { id: 1 }, { fetch: fake as any });
    expect(fake.mock.calls[0][0]).toBe(DEFAULT_SHOP_API_URL);
  });

  test("ohne Geheimnis kein Aufruf", async () => {
    vi.stubEnv("SHOP_WEBHOOK_SECRET", "");
    const fake = vi.fn();
    await expect(callShopApi("search", { q: "x" }, { fetch: fake as any })).rejects.toThrow(
      /SHOP_WEBHOOK_SECRET ist nicht gesetzt/,
    );
    expect(fake).not.toHaveBeenCalled();
  });

  test.each([
    ["Modul fehlt (HTML 404)", new Response("<html>nicht da</html>", { status: 404 }), /nicht gefunden \(HTTP 404\)/],
    ["Seite statt JSON", new Response("<html>Shop</html>", { status: 200 }), /kein JSON/],
    ["Signatur abgelehnt", jsonResponse({ ok: false, error: "bad_signature" }, 403), /lehnt die Anfrage ab/],
    ["Fachfehler", jsonResponse({ ok: false, error: "product_not_found" }, 404), /meldet einen Fehler: product_not_found/],
    ["ok fehlt", jsonResponse({ products: [] }), /meldet einen Fehler/],
  ])("verstaendlicher Fehler: %s", async (_name, response, message) => {
    const fake = vi.fn(async () => response);
    await expect(
      callShopApi("search", { q: "x" }, { fetch: fake as any, secret: SECRET }),
    ).rejects.toThrow(message);
  });

  test("Netzfehler", async () => {
    const fake = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      callShopApi("search", { q: "x" }, { fetch: fake as any, secret: SECRET }),
    ).rejects.toThrow(/Shop nicht erreichbar \(fetch failed\)/);
  });
});

describe("Antwortverarbeitung", () => {
  test("Preise in Cent", () => {
    expect(priceToCents(9.9)).toBe(990);
    expect(priceToCents("12,50")).toBe(1250);
    expect(priceToCents("abc")).toBeNull();
    expect(priceToCents(-1)).toBeNull();
  });

  test("Produkt mit und ohne Digital-Variante", () => {
    const p = parseProduct({
      id: "812",
      name: "DMZ Nr. 170",
      reference: "DMZ170",
      price_gross: "6.50",
      url: "https://lesenundschenken.de/812-dmz-170",
      cover_url: null,
      manufacturer: "Lesen und Schenken",
      active: 1,
      digital: { id_product_attribute: 44, sku: "DMZ-170-DIGITAL", price_gross: 4.99, available: true },
    });
    expect(p).toMatchObject({
      id: 812,
      priceCents: 650,
      coverUrl: null,
      active: true,
      digital: { idProductAttribute: 44, sku: "DMZ-170-DIGITAL", priceCents: 499, available: true },
    });
    expect(parseProduct({ id: 3, name: "X", url: "javascript:alert(1)" })?.url).toMatch(
      /^https:\/\/lesenundschenken\.de\//,
    );
    expect(parseProduct({ name: "ohne id" })).toBeNull();
  });

  test("Vorschlag und Rangfolge", () => {
    const pub = { name: "DMZ", slug: "dmz" };
    expect(suggestQuery(pub, { title: "Heft", issueNumber: "170" })).toBe("DMZ Nr. 170");
    expect(suggestQuery({ name: "Neue Reihe", slug: "neu" }, { title: "Heft", issueNumber: "4" })).toBe(
      "Neue Reihe 4",
    );
    const mk = (id: number, name: string, active = true) =>
      parseProduct({ id, name, url: "https://x.test/", active })!;
    const ranked = rankProducts(
      [mk(1, "DMZ Nr. 171"), mk(2, "DMZ Nr. 170", false), mk(3, "DMZ Nr. 170")],
      pub,
      "170",
    );
    expect(ranked.map((p) => p.id)).toEqual([3, 2, 1]);
  });

  test("Artikelnummer der Digital-Variante", () => {
    expect(seriesCode({ name: "ZUERST!", slug: "zuerst" })).toBe("ZUERST");
    expect(seriesCode({ name: "DMZ-Zeitgeschichte", slug: "dmz-zeitgeschichte" })).toBe("DMZ-ZG");
    expect(seriesCode({ name: "Schwerterträger", slug: "schwertertraeger" })).toBe("SCHWERTERTRAEGER");
    expect(digitalSku({ name: "ZUERST!", slug: "zuerst" }, { issueNumber: "3/2026", _id: "abc" })).toBe(
      "ZUERST-3-2026-DIGITAL",
    );
  });
});

describe("Redaktion: Druckheft zuordnen und anbieten", () => {
  async function setup(t: any, opts: { priceSource?: "redaktion"; sku?: string } = {}) {
    return await t.run(async (ctx: any) => {
      const adminId = await ctx.db.insert("users", { email: "admin@example.de", roles: ["admin"] });
      const editorId = await ctx.db.insert("users", { email: "red@example.de", roles: ["editor"] });
      const publicationId = await ctx.db.insert("publications", {
        name: "DMZ",
        slug: "dmz",
        isActive: true,
        createdAt: Date.now(),
      });
      // Belegt die naheliegende Nummer, damit die Eindeutigkeit greift.
      if (opts.sku) {
        await ctx.db.insert("issues", {
          publicationId,
          title: "Alt",
          slug: "alt",
          pageCount: 1,
          priceAmountCents: 100,
          isPublished: false,
          includedInSubscription: true,
          externalSku: opts.sku,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const issueId = await ctx.db.insert("issues", {
        publicationId,
        title: "DMZ 170",
        slug: "dmz-170",
        issueNumber: "170",
        pageCount: 1,
        priceAmountCents: opts.priceSource ? 700 : 590,
        priceSource: opts.priceSource,
        isPublished: true,
        includedInSubscription: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { adminId, editorId, issueId };
    });
  }

  function stubShop(handler: (body: any) => unknown) {
    const calls: any[] = [];
    vi.stubEnv("SHOP_WEBHOOK_SECRET", SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        return jsonResponse(handler(body));
      }),
    );
    return calls;
  }

  const product = {
    id: 812,
    name: "DMZ Nr. 170",
    reference: "DMZ170",
    price_gross: 6.5,
    url: "https://lesenundschenken.de/812-dmz-170",
    cover_url: null,
    manufacturer: "Lesen und Schenken",
    active: true,
    digital: null,
  };

  test("Auswahl uebernimmt Laden-Preis, Produktseite und vergibt die Artikelnummer eindeutig", async () => {
    const t = convexTest(schema, modules);
    const { adminId, issueId } = await setup(t, { sku: "DMZ-170-DIGITAL" });
    const calls = stubShop(() => ({ ok: true, product }));
    const asAdmin = t.withIdentity({ subject: adminId });
    const res = await asAdmin.action(api.shopCatalog.select, { issueId, productId: 812 });
    expect(calls[0]).toMatchObject({ action: "product", id: 812 });
    expect(res.messages).toContain("Artikelnummer DMZ-170-DIGITAL-2");
    const issue = await t.run(async (ctx: any) => await ctx.db.get(issueId));
    expect(issue).toMatchObject({
      shopProductId: 812,
      shopUrl: product.url,
      priceAmountCents: 650,
      priceSource: "laden",
      externalSku: "DMZ-170-DIGITAL-2",
      shopDigital: { offered: false },
    });
  });

  test("Preis der Redaktion bleibt stehen", async () => {
    const t = convexTest(schema, modules);
    const { adminId, issueId } = await setup(t, { priceSource: "redaktion" });
    stubShop(() => ({ ok: true, product }));
    await t.withIdentity({ subject: adminId }).action(api.shopCatalog.select, { issueId, productId: 812 });
    const issue = await t.run(async (ctx: any) => await ctx.db.get(issueId));
    expect(issue.priceAmountCents).toBe(700);
    expect(issue.priceSource).toBe("redaktion");
  });

  test("Anbieten und Zuruecknehmen", async () => {
    const t = convexTest(schema, modules);
    const { adminId, issueId } = await setup(t);
    const calls = stubShop((body) => {
      if (body.action === "product") return { ok: true, product };
      if (body.action === "offer_digital") {
        return { ok: true, id_product_attribute: 55, url: "https://lesenundschenken.de/812-dmz-170#/55-e-paper" };
      }
      return { ok: true };
    });
    const asAdmin = t.withIdentity({ subject: adminId });
    await asAdmin.action(api.shopCatalog.select, { issueId, productId: 812 });
    const offered = await asAdmin.action(api.shopCatalog.offer, { issueId });
    expect(calls.find((c) => c.action === "offer_digital")).toMatchObject({
      id_product: 812,
      sku: "DMZ-170-DIGITAL",
      price_gross: 6.5,
      available: true,
    });
    expect(offered).toMatchObject({ offered: true, idProductAttribute: 55, priceCents: 650 });
    let issue = await t.run(async (ctx: any) => await ctx.db.get(issueId));
    expect(issue.shopUrl).toBe("https://lesenundschenken.de/812-dmz-170#/55-e-paper");

    const withdrawn = await asAdmin.action(api.shopCatalog.withdraw, { issueId });
    expect(calls.find((c) => c.action === "withdraw_digital")).toMatchObject({
      id_product: 812,
      sku: "DMZ-170-DIGITAL",
    });
    expect(withdrawn.offered).toBe(false);
    issue = await t.run(async (ctx: any) => await ctx.db.get(issueId));
    expect(issue.shopUrl).toBe(product.url);
  });

  test("nur fuer Admins, und ein fehlendes Modul bricht nichts", async () => {
    const t = convexTest(schema, modules);
    const { adminId, editorId, issueId } = await setup(t);
    vi.stubEnv("SHOP_WEBHOOK_SECRET", SECRET);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>404</html>", { status: 404 })));
    await expect(
      t.withIdentity({ subject: editorId }).action(api.shopCatalog.search, { issueId }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity({ subject: adminId }).action(api.shopCatalog.search, { issueId }),
    ).rejects.toThrow(/Modul lusdigital/);
    const issue = await t.run(async (ctx: any) => await ctx.db.get(issueId));
    expect(issue.shopProductId).toBeUndefined();
  });
});
