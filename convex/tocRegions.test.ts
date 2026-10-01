import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

/**
 * Ein Heft mit zwei Artikeln: der erste beginnt auf Seite 5 und steht im
 * Inhaltsverzeichnis, der zweite beginnt auf Seite 8 ohne Eintrag. Dazu die
 * alten, falsch liegenden Verzeichnisflaechen und eine Textflaeche, die
 * bleiben muss.
 */
async function heft(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "DMZ",
      slug: "dmz",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "Heft",
      slug: `heft-${Math.random().toString(36).slice(2)}`,
      pageCount: 10,
      priceAmountCents: 980,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const artikel = async (order: number, pageStart: number) =>
      await ctx.db.insert("articles", {
        issueId,
        order,
        title: `Artikel ${order}`,
        source: "idml",
        reviewStatus: "approved",
        primaryPageIndex: pageStart,
        pageStart,
        pageEnd: pageStart + 1,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
    const erster = await artikel(1, 5);
    const zweiter = await artikel(2, 8);
    // Beginnt eine Seite nach seiner Aufmacherseite 9.
    const dritter = await artikel(3, 10);
    await ctx.db.insert("tocEntries", {
      issueId,
      order: 1,
      label: "Erster",
      pageIndex: 5,
      articleId: erster,
      level: 1,
    });
    await ctx.db.insert("articleRegions", {
      issueId,
      articleId: erster,
      pageIndex: 2,
      x0: 0.05,
      y0: 0.2,
      x1: 0.5,
      y1: 0.25,
      kind: "other",
      targetPageIndex: 5,
      order: 0,
    });
    await ctx.db.insert("articleRegions", {
      issueId,
      articleId: erster,
      pageIndex: 5,
      x0: 0.05,
      y0: 0.05,
      x1: 0.95,
      y1: 0.95,
      kind: "body",
      order: 1,
    });
    const jobId = await ctx.db.insert("importJobs", {
      issueId,
      kind: "toc",
      status: "running",
      attempts: 1,
      workerId: "w1",
      createdAt: now,
    });
    return { issueId, jobId, erster, zweiter, dritter };
  });
}

describe("Klickflaechen des Inhaltsverzeichnisses", () => {
  test("ersetzt nur die Verzeichnisflaechen und haengt sie an den Zielartikel", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId, erster, zweiter, dritter } = await heft(t);

    const result = await t.mutation(internal.imports.activateTocRegionsInternal, {
      jobId,
      workerId: "w1",
      issueId,
      regions: [
        // Ueber den Verzeichniseintrag.
        { pageIndex: 2, x0: 0.06, y0: 0.11, x1: 0.35, y1: 0.14, targetPageIndex: 5 },
        // Kein Eintrag, aber ein Artikel beginnt dort.
        { pageIndex: 2, x0: 0.06, y0: 0.2, x1: 0.35, y1: 0.23, targetPageIndex: 8 },
        // Aufmacherseite: der Artikel beginnt eine Seite spaeter.
        { pageIndex: 2, x0: 0.06, y0: 0.3, x1: 0.35, y1: 0.33, targetPageIndex: 9 },
        // Weder Eintrag noch Artikel: faellt weg.
        { pageIndex: 2, x0: 0.06, y0: 0.4, x1: 0.35, y1: 0.43, targetPageIndex: 12 },
      ],
    });
    expect(result).toEqual({ regions: 3, skipped: 1, entries: 0 });

    const regions = await t.run(async (ctx: any) =>
      await ctx.db
        .query("articleRegions")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect(),
    );
    const verzeichnis = regions
      .filter((r: any) => r.targetPageIndex !== undefined)
      .sort((a: any, b: any) => a.order - b.order);
    expect(verzeichnis.map((r: any) => [r.articleId, r.targetPageIndex, r.y0])).toEqual([
      [erster, 5, 0.11],
      [zweiter, 8, 0.2],
      [dritter, 9, 0.3],
    ]);
    // Die Textflaeche des Artikels ist unangetastet.
    const text = regions.filter((r: any) => r.targetPageIndex === undefined);
    expect(text).toHaveLength(1);
    expect(text[0].kind).toBe("body");
  });

  test("die Folgeseite zaehlt nicht, wenn ein eigener Eintrag auf sie zeigt", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId, dritter } = await heft(t);
    const result = await t.mutation(internal.imports.activateTocRegionsInternal, {
      jobId,
      workerId: "w1",
      issueId,
      regions: [
        { pageIndex: 2, x0: 0.06, y0: 0.3, x1: 0.35, y1: 0.33, targetPageIndex: 9 },
        { pageIndex: 2, x0: 0.06, y0: 0.4, x1: 0.35, y1: 0.43, targetPageIndex: 10 },
      ],
    });
    expect(result).toEqual({ regions: 1, skipped: 1, entries: 0 });
    const regions = await t.run(async (ctx: any) =>
      await ctx.db
        .query("articleRegions")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect(),
    );
    const neu = regions.filter((r: any) => r.targetPageIndex !== undefined);
    expect(neu.map((r: any) => [r.articleId, r.targetPageIndex])).toEqual([[dritter, 10]]);
  });

  test("traegt fehlende Eintraege des gedruckten Verzeichnisses nach", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId, erster, zweiter } = await heft(t);
    const result = await t.mutation(internal.imports.activateTocRegionsInternal, {
      jobId,
      workerId: "w1",
      issueId,
      regions: [],
      entries: [
        // Gibt es schon, nur vollstaendiger: der Eintrag waechst.
        { label: "Wahlrechtsentzug statt Erster", pageIndex: 5 },
        // Neu, mit Artikel auf der Zielseite.
        { label: "Nachruf", pageIndex: 8, section: "Rubriken" },
        // Neu, ohne Artikel.
        { label: "Kalenderblatt", pageIndex: 3 },
      ],
    });
    expect(result).toEqual({ regions: 0, skipped: 0, entries: 2 });
    const toc = await t.run(async (ctx: any) =>
      (await ctx.db
        .query("tocEntries")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect()).sort((a: any, b: any) => a.order - b.order),
    );
    expect(toc.map((e: any) => [e.order, e.label, e.pageIndex, e.articleId ?? null])).toEqual([
      [1, "Kalenderblatt", 3, null],
      [2, "Wahlrechtsentzug statt Erster", 5, erster],
      [3, "Nachruf", 8, zweiter],
    ]);
  });

  test("weist einen fremden Worker ab", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId } = await heft(t);
    await expect(
      t.mutation(internal.imports.activateTocRegionsInternal, {
        jobId,
        workerId: "w2",
        issueId,
        regions: [],
      }),
    ).rejects.toThrow(/anderen Worker/);
  });

  test("enqueueInternal stellt einen Auftrag ohne Anmeldung ein", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId } = await heft(t);
    // Der laufende Auftrag aus dem Aufbau blockiert einen zweiten.
    await expect(
      t.mutation(internal.imports.enqueueInternal, { issueId, kind: "toc" }),
    ).rejects.toThrow(/bereits ein Auftrag/);
    await t.run(async (ctx: any) => ctx.db.patch(jobId, { status: "done" }));
    const neu = await t.mutation(internal.imports.enqueueInternal, { issueId, kind: "toc" });
    const job = await t.run(async (ctx: any) => ctx.db.get(neu));
    expect(job.kind).toBe("toc");
    expect(job.status).toBe("queued");
  });
});
