import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { aufAusschnitt } from "./issuePages";

const modules = import.meta.glob("./**/*.ts");

// Wie Doppelband 154: 1400 x 1927 mit Marken, Netzformat 63..1336 x 63..1863.
const A = { x0: 63 / 1400, y0: 63 / 1927, x1: 1336 / 1400, y1: 1863 / 1927 };

async function heft(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "Weltkrieg Doppelband",
      slug: "weltkrieg-doppelband",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "Eine Frage der Zeit",
      slug: `wk-${Math.random().toString(36).slice(2)}`,
      pageCount: 6,
      priceAmountCents: 0,
      isPublished: false,
      includedInSubscription: false,
      createdAt: now,
      updatedAt: now,
    });
    const quelle = await ctx.db.insert("assets", {
      key: "uploads/x/textebene.json",
      contentType: "application/json",
      kind: "source",
      issueId,
      createdAt: now,
    });
    for (const index of [2, 3]) {
      await ctx.db.insert("issuePages", {
        issueId,
        index,
        role: "content",
        sourceAssetId: quelle,
        sourcePageIndex: index - 2,
        width: 1400,
        height: 1927,
        previewKey: `alt-${index}`,
      });
    }
    const articleId = await ctx.db.insert("articles", {
      issueId,
      order: 1,
      title: "Eine Frage der Zeit",
      source: "pdf",
      reviewStatus: "approved",
      primaryPageIndex: 2,
      pageStart: 2,
      pageEnd: 3,
      searchText: "",
      createdAt: now,
      updatedAt: now,
    });
    const flaeche = await ctx.db.insert("articleRegions", {
      articleId,
      issueId,
      pageIndex: 2,
      x0: A.x0,
      y0: 0.5,
      x1: A.x1,
      y1: A.y1,
      kind: "body",
      order: 0,
    });
    const andere = await ctx.db.insert("articleRegions", {
      articleId,
      issueId,
      pageIndex: 3,
      x0: 0.1,
      y0: 0.1,
      x1: 0.2,
      y1: 0.2,
      kind: "body",
      order: 1,
    });
    const link = await ctx.db.insert("pageLinks", {
      issueId,
      pageIndex: 2,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
      kind: "url",
      url: "https://weltkrieg-online.de/",
      source: "import",
    });
    const absatz = await ctx.db.insert("articleBlocks", {
      articleId,
      issueId,
      order: 1,
      type: "paragraph",
      text: "Text",
      sourcePageIndex: 2,
      sourceY: 0.5,
    });
    const jobId = await ctx.db.insert("importJobs", {
      issueId,
      kind: "beschnitt",
      status: "running",
      attempts: 1,
      workerId: "w1",
      createdAt: now,
    });
    return { issueId, jobId, flaeche, andere, link, absatz };
  });
}

const seite2 = { index: 2, altKey: "alt-2", neuKey: "neu-2", width: 1273, height: 1800, ...A };

describe("Schnittmarken entfernen", () => {
  test("Ausschnitt: Schnittkante wird Rand, Mitte bleibt Mitte", () => {
    expect(aufAusschnitt(A, A.x0, A.y1)).toEqual({ x: 0, y: 1 });
    const m = aufAusschnitt(A, 0.5, 0.5);
    expect(m.x).toBeCloseTo(0.5, 2);
    expect(m.y).toBeCloseTo(0.5, 2);
    // Was im Rand lag, landet auf der Kante.
    expect(aufAusschnitt(A, 0, 0.999)).toEqual({ x: 0, y: 1 });
  });

  test("Seite, Flaechen, Links und Absaetze der Seite werden umgerechnet", async () => {
    const t = convexTest(schema, modules);
    const ids = await heft(t);
    const r = await t.mutation(internal.issuePages.beschnittUebernehmenInternal, {
      jobId: ids.jobId,
      workerId: "w1",
      issueId: ids.issueId,
      seiten: [seite2],
    });
    expect(r).toEqual({
      seiten: 1,
      angewendet: [2],
      uebersprungen: 0,
      flaechen: 1,
      links: 1,
      absaetze: 1,
      bilder: 0,
    });
    const stand = await t.run(async (ctx: any) => ({
      seiten: await ctx.db.query("issuePages").collect(),
      flaeche: await ctx.db.get(ids.flaeche),
      andere: await ctx.db.get(ids.andere),
      link: await ctx.db.get(ids.link),
      absatz: await ctx.db.get(ids.absatz),
    }));
    const s2 = stand.seiten.find((p: any) => p.index === 2);
    expect([s2.previewKey, s2.width, s2.height]).toEqual(["neu-2", 1273, 1800]);
    expect(s2.beschnitt).toEqual(A);
    // Seite 3 ist nicht zugeschnitten: alles bleibt.
    expect(stand.seiten.find((p: any) => p.index === 3).previewKey).toBe("alt-3");
    expect([stand.andere.x0, stand.andere.y0]).toEqual([0.1, 0.1]);
    // Die Flaeche lag auf den Schnittkanten.
    expect(stand.flaeche.x0).toBeCloseTo(0, 6);
    expect(stand.flaeche.x1).toBeCloseTo(1, 6);
    expect(stand.flaeche.y1).toBeCloseTo(1, 6);
    expect(stand.flaeche.y0).toBeCloseTo((0.5 - A.y0) / (A.y1 - A.y0), 6);
    // Ein Link ueber die ganze alte Seite deckt die ganze neue.
    expect([stand.link.x0, stand.link.y0, stand.link.x1, stand.link.y1]).toEqual([0, 0, 1, 1]);
    expect(stand.absatz.sourceY).toBeCloseTo((0.5 - A.y0) / (A.y1 - A.y0), 6);
  });

  test("ein zweiter Lauf rechnet nichts doppelt um", async () => {
    const t = convexTest(schema, modules);
    const ids = await heft(t);
    const lauf = () =>
      t.mutation(internal.issuePages.beschnittUebernehmenInternal, {
        jobId: ids.jobId,
        workerId: "w1",
        issueId: ids.issueId,
        seiten: [seite2],
      });
    await lauf();
    const vorher = await t.run(async (ctx: any) => ctx.db.get(ids.absatz));
    const zweiter = await lauf();
    expect(zweiter.seiten).toBe(0);
    expect(zweiter.uebersprungen).toBe(1);
    const nachher = await t.run(async (ctx: any) => ctx.db.get(ids.absatz));
    expect(nachher.sourceY).toBe(vorher.sourceY);
  });

  test("weist einen fremden Worker ab", async () => {
    const t = convexTest(schema, modules);
    const ids = await heft(t);
    await expect(
      t.mutation(internal.issuePages.beschnittUebernehmenInternal, {
        jobId: ids.jobId,
        workerId: "w2",
        issueId: ids.issueId,
        seiten: [seite2],
      }),
    ).rejects.toThrow(/anderen Worker/);
  });
});
