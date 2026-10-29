import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { ankerFinden } from "./bildnachtrag";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function heftMitArtikel(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "ZUERST! 6/2025",
      slug: "zuerst-6-2025",
      pageCount: 84,
      priceAmountCents: 590,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const articleId = await ctx.db.insert("articles", {
      issueId,
      order: 38,
      title: "„Den Blick nach vorn richten“",
      source: "idml",
      reviewStatus: "approved",
      primaryPageIndex: 33,
      pageStart: 33,
      pageEnd: 33,
      searchText: "Nothdurft",
      createdAt: now,
      updatedAt: now,
    });
    for (const [i, text] of [
      "Herr Nothdurft, in Ihrer Funktion als Ortsbürgermeister von Roßlau hielten Sie eine Rede.",
      "Nothdurft: Als gewählter Ortsbürgermeister meiner Heimatstadt Roßlau hatte ich die Ehre.",
    ].entries()) {
      await ctx.db.insert("articleBlocks", { articleId, issueId, order: i + 1, type: "paragraph", text });
    }
    const asset = async (key: string) =>
      await ctx.db.insert("assets", { key, contentType: "image/jpeg", kind: "image", issueId, createdAt: now });
    const altA = await asset("images/33-667-61.jpg");
    const altB = await asset("images/33-48-754.jpg");
    await ctx.db.insert("articleAssets", { articleId, issueId, assetId: altA, order: 0, sourcePageIndex: 33 });
    await ctx.db.insert("articleAssets", { articleId, issueId, assetId: altB, order: 1, sourcePageIndex: 33 });
    await ctx.db.insert("articleRegions", {
      articleId, issueId, pageIndex: 33, x0: 0.6, y0: 0.0, x1: 1, y1: 0.4, kind: "image",
    });
    await ctx.db.insert("articleRegions", {
      articleId, issueId, pageIndex: 33, x0: 0.05, y0: 0.3, x1: 0.33, y1: 0.7, kind: "body",
    });
    const neuA = await asset("images/33-667-61-nabc123.jpg");
    const neuB = await asset("images/33-48-754-nabc123.jpg");
    const jobId = await ctx.db.insert("importJobs", {
      issueId, kind: "nachtrag", status: "running", payload: "bilder", attempts: 1, createdAt: now,
    });
    return { issueId, articleId, neuA, neuB, jobId };
  });
}

describe("Bilder-Nachtrag ohne Neuimport", () => {
  test("ersetzt Bilder und Unterschriften, Text und Freigabe bleiben, Rueckweg setzt zurueck", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId, neuA, neuB, jobId } = await heftMitArtikel(t);
    const gesichert = await t.query(internal.bildnachtrag.bestandInternal, { issueId });
    expect(gesichert.bilder).toHaveLength(2);
    expect(gesichert.flaechen).toHaveLength(1);

    const eingabe = {
      jobId,
      workerId: "w",
      issueId,
      articles: [
        {
          articleId,
          images: [
            { assetId: neuA, sourcePageIndex: 33, sourceY: 0.06 },
            {
              assetId: neuB,
              sourcePageIndex: 33,
              sourceY: 0.75,
              caption: "Bürgermeister Laurens Nothdurft (rechts) mit Roßlauer Schülern am 8. Mai.",
              // Der Absatz steht heute an Stelle 2, im neuen Satz an Stelle 5.
              afterBlockOrder: 5,
              anchorText: "Nothdurft: Als gewählter Ortsbürgermeister meiner Heimatstadt",
            },
          ],
          imageRegions: [
            { pageIndex: 33, x0: 0.667, y0: 0.061, x1: 0.952, y1: 0.357 },
            { pageIndex: 33, x0: 0.048, y0: 0.754, x1: 0.643, y1: 1 },
          ],
        },
      ],
    };
    const probe = await t.mutation(internal.bildnachtrag.ersetzenInternal, { ...eingabe, probe: true });
    expect(probe).toMatchObject({ artikel: 1, geaendert: 1, unterschriftenVorher: 0, unterschriftenNachher: 1 });
    const nachProbe = await t.query(internal.bildnachtrag.bestandInternal, { issueId });
    expect(nachProbe.bilder.map((b) => b.assetId)).toEqual(gesichert.bilder.map((b) => b.assetId));

    await t.mutation(internal.bildnachtrag.ersetzenInternal, { ...eingabe, probe: false });
    const stand = await t.run(async (ctx) => ({
      bilder: await ctx.db.query("articleAssets").withIndex("by_article", (q) => q.eq("articleId", articleId)).collect(),
      flaechen: await ctx.db.query("articleRegions").withIndex("by_article", (q) => q.eq("articleId", articleId)).collect(),
      artikel: await ctx.db.get(articleId),
      bloecke: await ctx.db.query("articleBlocks").withIndex("by_article", (q) => q.eq("articleId", articleId)).collect(),
    }));
    expect(stand.bilder.map((b) => [b.assetId, b.caption ?? null, b.afterBlockOrder ?? null])).toEqual([
      [neuA, null, null],
      [neuB, "Bürgermeister Laurens Nothdurft (rechts) mit Roßlauer Schülern am 8. Mai.", 2],
    ]);
    expect(stand.flaechen.filter((f) => f.kind === "image")).toHaveLength(2);
    expect(stand.flaechen.filter((f) => f.kind === "body")).toHaveLength(1);
    expect(stand.artikel?.reviewStatus).toBe("approved");
    expect(stand.bloecke).toHaveLength(2);

    const zurueck = await t.mutation(internal.bildnachtrag.wiederherstellenInternal, {
      issueId,
      bilder: gesichert.bilder,
      flaechen: gesichert.flaechen,
    });
    expect(zurueck).toMatchObject({ artikel: 1, bilder: 2, fehlendeArtikel: 0 });
    const wieder = await t.query(internal.bildnachtrag.bestandInternal, { issueId });
    expect(wieder.bilder.map((b) => [b.assetId, b.order])).toEqual(gesichert.bilder.map((b) => [b.assetId, b.order]));
    expect(wieder.flaechen.map((f) => f.x0)).toEqual([0.6]);
  });

  test("fremder Artikel bricht ab", async () => {
    const t = convexTest(schema, modules);
    const a = await heftMitArtikel(t);
    const b = await heftMitArtikel(t);
    await expect(
      t.mutation(internal.bildnachtrag.ersetzenInternal, {
        jobId: a.jobId,
        workerId: "w",
        issueId: a.issueId,
        probe: false,
        articles: [{ articleId: b.articleId, images: [], imageRegions: [] }],
      }),
    ).rejects.toThrow(/gehoert nicht/);
  });
});

describe("Anker im heutigen Text", () => {
  const bloecke = [
    { order: 1, text: "Herr Nothdurft, in Ihrer Funktion als Ortsbürgermeister" },
    { order: 2, text: "Nothdurft: Als gewählter Ortsbürgermeister meiner Heimatstadt" },
  ];
  test("findet den Absatz nach seinem Anfang", () => {
    expect(ankerFinden(bloecke, "Nothdurft:  Als gewählter Ortsbürgermeister", 7)).toBe(2);
  });
  test("verschwundener Absatz: kein Anker, das Bild steht nach seiner Lage", () => {
    expect(ankerFinden(bloecke, "Dieser Absatz wurde von der Redaktion geloescht", 2)).toBeUndefined();
  });
  test("ohne Text gilt die Nummer nur, wenn es sie gibt", () => {
    expect(ankerFinden(bloecke, undefined, 2)).toBe(2);
    expect(ankerFinden(bloecke, undefined, 9)).toBeUndefined();
  });
});
