import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  chooseProduct,
  chooseTarget,
  defaultSubscriptionUrl,
  searchUrl,
  seriesUrl,
} from "./pageLinks";

const modules = import.meta.glob("./**/*.ts");

async function heft(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "Heft",
      slug: `heft-${Math.random().toString(36).slice(2)}`,
      pageCount: 4,
      priceAmountCents: 870,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("pageLinks", {
      issueId,
      pageIndex: 1,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
      kind: "subscription",
      publicationSlug: "dmz",
      source: "import",
    });
    await ctx.db.insert("pageLinks", {
      issueId,
      pageIndex: 5,
      x0: 0.1,
      y0: 0.1,
      x1: 0.4,
      y1: 0.3,
      kind: "url",
      url: "https://lesenundschenken.de/aktion",
      source: "editor",
    });
    return { issueId };
  });
}

describe("Seitenlinks", () => {
  test("der Import ersetzt nur seine eigenen Flaechen", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const result = await t.mutation(internal.pageLinks.replaceImportedInternal, {
      issueId,
      links: [
        {
          pageIndex: 82,
          x0: 0,
          y0: 0,
          x1: 1,
          y1: 1,
          kind: "subscription",
          publicationSlug: "zuerst",
          label: "Abonnement",
        },
      ],
    });
    expect(result).toEqual({ links: 1 });
    const rows = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pageLinks")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect(),
    );
    expect(rows.map((r: any) => [r.pageIndex, r.source])).toEqual([
      [5, "editor"],
      [82, "import"],
    ]);
  });

  test("das Abo-Formular folgt der Kennung der Reihe", () => {
    expect(defaultSubscriptionUrl("dmz-zeitgeschichte")).toBe(
      "https://lesenundschenken.de/module/luszeitformulare/formular?f=abo-dmz-zeitgeschichte",
    );
    expect(seriesUrl("schwertertraeger")).toBe(
      "https://lesenundschenken.de/zeitschriften/schwertertraeger",
    );
    expect(searchUrl("Waffen-SS")).toBe("https://lesenundschenken.de/suche?s=Waffen-SS");
  });

  test("ein Produkt nur bei genau einem Treffer", () => {
    const produkt = (id: number, reference: string, active = true) => ({
      id,
      name: `Buch ${id}`,
      reference,
      priceCents: 2980,
      url: `https://lesenundschenken.de/${id}-buch.html`,
      coverUrl: null,
      manufacturer: "",
      active,
      digital: null,
    });
    expect(chooseProduct([produkt(1, "101208")])?.id).toBe(1);
    expect(chooseProduct([produkt(1, "101208"), produkt(2, "101209")])).toBeNull();
    expect(chooseProduct([produkt(1, "101208"), produkt(2, "101209")], "101209")?.id).toBe(2);
    expect(chooseProduct([produkt(1, "101208", false)])).toBeNull();
    expect(chooseProduct([])).toBeNull();
  });

  test("Einzelanzeige zur Produktseite, Sammelanzeige zur Liste", () => {
    const produkt = (id: number) => ({
      id,
      name: `Buch ${id}`,
      reference: String(100000 + id),
      priceCents: 2980,
      url: `https://lesenundschenken.de/${id}-buch.html`,
      coverUrl: null,
      manufacturer: "",
      active: true,
      digital: null,
    });
    const viele = (n: number) => Array.from({ length: n }, (_, i) => produkt(i + 1));
    // Ein Buch: der Titel trifft genau eines.
    expect(
      chooseTarget(
        [
          { q: "Ulrich Steinmetz", products: viele(3) },
          { q: "Zeugen deutscher Geschichte", products: [produkt(9)] },
        ],
        true,
      ),
    ).toBe("https://lesenundschenken.de/9-buch.html");
    // Mehrere Buecher eines Verfassers: seine Liste, nicht das eine Buch, das
    // ein einzelnes Wort zufaellig trifft.
    expect(
      chooseTarget(
        [
          { q: "Stefan Scheil", products: viele(8) },
          { q: "Der Historiker", products: [produkt(4)] },
          { q: "Historiker", products: viele(20) },
        ],
        false,
      ),
    ).toBe(searchUrl("Stefan Scheil"));
    // Sammelanzeige ohne Verfasser: der Begriff mit den meisten Treffern.
    expect(
      chooseTarget(
        [
          { q: "Bücher zur Geschichte der Waffen-SS", products: [produkt(1)] },
          { q: "Waffen-SS", products: viele(12) },
        ],
        false,
      ),
    ).toBe(searchUrl("Waffen-SS"));
    expect(chooseTarget([], true)).toBeNull();
  });
});
