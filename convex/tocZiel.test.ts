import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { titelForm, zielSeite } from "./tocZiel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Wie DMZ 170: Inhaltsseite 2, "Nachrichten aus Deutschland" auf 34,
 * "Nachrichten aus aller Welt" auf 50, die Leserbriefe laufen ueber 79/80.
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
      pageCount: 84,
      priceAmountCents: 980,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const artikel = async (order: number, title: string, pageStart: number, pageEnd = pageStart) =>
      await ctx.db.insert("articles", {
        issueId,
        order,
        title,
        source: "idml",
        reviewStatus: "approved",
        primaryPageIndex: pageStart,
        pageStart,
        pageEnd,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
    const deutschland = await artikel(1, "Nachrichten aus Deutschland", 34);
    const welt = await artikel(2, "Nachrichten aus aller Welt", 50);
    const briefe = await artikel(3, "Leserbriefe", 79, 80);
    await ctx.db.insert("tocEntries", {
      issueId,
      order: 1,
      label: "Nachrichten aus Deutschland",
      pageIndex: 34,
      articleId: deutschland,
      level: 1,
    });
    // Die Redaktion hat den Druckfehler (35 statt 51) im Eintrag berichtigt.
    await ctx.db.insert("tocEntries", {
      issueId,
      order: 2,
      label: "Nachrichten aus aller Welt",
      pageIndex: 50,
      articleId: welt,
      level: 1,
    });
    const jobId = await ctx.db.insert("importJobs", {
      issueId,
      kind: "toc",
      status: "running",
      attempts: 1,
      workerId: "w1",
      createdAt: now,
    });
    return { issueId, jobId, deutschland, welt, briefe };
  });
}

async function sprungflaechen(t: any, issueId: any) {
  const rows = await t.run(async (ctx: any) =>
    await ctx.db
      .query("articleRegions")
      .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
      .collect(),
  );
  return rows
    .filter((r: any) => r.targetPageIndex !== undefined)
    .sort((a: any, b: any) => a.y0 - b.y0)
    .map((r: any) => [r.articleId, r.targetPageIndex]);
}

describe("Ziel einer Verzeichniszeile", () => {
  test("Druckfehler: die Zeile folgt dem berichtigten Eintrag", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId, deutschland, welt, briefe } = await heft(t);
    const result = await t.mutation(internal.imports.activateTocRegionsInternal, {
      jobId,
      workerId: "w1",
      issueId,
      regions: [
        { pageIndex: 2, x0: 0.5, y0: 0.73, x1: 0.8, y1: 0.75, targetPageIndex: 34, label: "Nachrichten aus Deutschland" },
        { pageIndex: 2, x0: 0.5, y0: 0.75, x1: 0.8, y1: 0.77, targetPageIndex: 34, label: "Nachrichten aus aus aller Welt" },
        // Der Eintrag steht mitten im Artikel, der eine Seite frueher beginnt.
        { pageIndex: 2, x0: 0.5, y0: 0.8, x1: 0.8, y1: 0.82, targetPageIndex: 80, label: "Leserbriefe/Impressum" },
      ],
    });
    expect(result).toMatchObject({ regions: 3, skipped: 0 });
    expect(await sprungflaechen(t, issueId)).toEqual([
      [deutschland, 34],
      [welt, 50],
      [briefe, 80],
    ]);
  });

  test("nachgetragene Eintraege verdoppeln weder Druckfehler noch Satzzeichen", async () => {
    const t = convexTest(schema, modules);
    const { issueId, jobId } = await heft(t);
    const result = await t.mutation(internal.imports.activateTocRegionsInternal, {
      jobId,
      workerId: "w1",
      issueId,
      regions: [],
      entries: [
        { label: "Nachrichten aus Deutschland", pageIndex: 34 },
        // Gedruckt mit der 35 und doppeltem Wort, berichtigt auf 50.
        { label: "Nachrichten aus aus aller Welt", pageIndex: 34 },
        // Gleicher Titel ohne Gedankenstrich.
        { label: "Nachrichten – aus Deutschland", pageIndex: 34 },
      ],
    });
    expect(result).toMatchObject({ entries: 0 });
  });

  test("titelForm und zielSeite", () => {
    expect(titelForm("Nachrichten aus aus aller Welt")).toBe("nachrichten aus aller welt");
    const artikel = [
      { _id: "a" as any, order: 1, title: "Offizier", pageStart: 9, pageEnd: 12 },
      { _id: "b" as any, order: 2, title: "Orden", pageStart: 30, pageEnd: 31 },
    ];
    // Aufmacherseite: der Artikel beginnt eine Seite spaeter, kein Druckfehler.
    expect(zielSeite("Offizier", 8, [], artikel)).toBe(8);
    // Druckfehler: der einzige Artikel mit dem Titel steht woanders.
    expect(zielSeite("Orden", 13, [], artikel)).toBe(30);
    // Ohne passenden Titel bleibt die gedruckte Zahl.
    expect(zielSeite("Etwas anderes", 13, [], artikel)).toBe(13);
  });
});

describe("Sprungflaechen ueberleben das Loeschen ihres Artikels", () => {
  async function mitFlaeche(t: any) {
    const h = await heft(t);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("articleRegions", {
        issueId: h.issueId,
        articleId: h.deutschland,
        pageIndex: 2,
        x0: 0.5,
        y0: 0.73,
        x1: 0.8,
        y1: 0.75,
        kind: "other",
        targetPageIndex: 34,
        order: 0,
      });
      await ctx.db.insert("articleRegions", {
        issueId: h.issueId,
        articleId: h.deutschland,
        pageIndex: 34,
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
        kind: "body",
        order: 1,
      });
    });
    return h;
  }

  test("Loeschen: die Zeile geht an den Artikel, der jetzt auf der Seite beginnt", async () => {
    const t = convexTest(schema, modules);
    const h = await mitFlaeche(t);
    const neu = await t.run(async (ctx: any) =>
      await ctx.db.insert("articles", {
        issueId: h.issueId,
        order: 4,
        title: "Nachrichten aus Deutschland",
        source: "idml",
        reviewStatus: "approved",
        primaryPageIndex: 34,
        pageStart: 34,
        pageEnd: 34,
        searchText: "",
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    await t.mutation(internal.articles.removeInternal, { articleId: h.deutschland });
    expect(await sprungflaechen(t, h.issueId)).toEqual([[neu, 34]]);
    // Die Textflaeche des geloeschten Artikels ist weg.
    const alle = await t.run(async (ctx: any) =>
      await ctx.db
        .query("articleRegions")
        .withIndex("by_issue", (q: any) => q.eq("issueId", h.issueId))
        .collect(),
    );
    expect(alle).toHaveLength(1);
  });

  test("Loeschen ohne Nachfolger: die Zeile faellt weg", async () => {
    const t = convexTest(schema, modules);
    const h = await mitFlaeche(t);
    await t.mutation(internal.articles.removeInternal, { articleId: h.deutschland });
    expect(await sprungflaechen(t, h.issueId)).toEqual([]);
  });

  test("Nachtrag ersetzt den Artikel: die Zeile haengt am neuen", async () => {
    const t = convexTest(schema, modules);
    const h = await mitFlaeche(t);
    const summary = await t.mutation(internal.imports.mergeResultInternal, {
      jobId: h.jobId,
      workerId: "w1",
      issueId: h.issueId,
      probe: false,
      remove: [h.deutschland],
      insert: [
        {
          order: 1,
          title: "Nachrichten aus Deutschland",
          source: "idml",
          primaryPageIndex: 34,
          pageStart: 34,
          pageEnd: 34,
          blocks: [],
          regions: [],
        },
      ],
      orders: [],
    });
    expect(summary.inserted).toHaveLength(1);
    const flaechen = await sprungflaechen(t, h.issueId);
    expect(flaechen).toHaveLength(1);
    expect(flaechen[0][0]).not.toBe(h.deutschland);
    expect(flaechen[0][1]).toBe(34);
  });
});
