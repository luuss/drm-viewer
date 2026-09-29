import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

const TABELLE = {
  headerRows: 1,
  columnWidths: [0.25, 0.75],
  rows: [
    [
      { text: "Nr.", header: true },
      { text: "Name", header: true },
    ],
    [{ text: "1" }, { text: "Erwin Rommel" }],
    [
      { text: "38", emphasis: true },
      { text: "Robert von Greim", emphasis: true },
    ],
  ],
};
const TEXT = "Nr. | Name\n1 | Erwin Rommel\n38 | Robert von Greim";

async function heft(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "Schwerterträger",
      slug: "schwerter",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "Greim",
      slug: "greim-36",
      pageCount: 49,
      priceAmountCents: 990,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("users", {
      email: "admin@example.de",
      roles: ["admin"],
    });
    return { issueId, adminId };
  });
}

async function artikel(
  ctx: any,
  issueId: any,
  order: number,
  title: string,
  page: number,
  blocks: { text: string; story?: string }[],
) {
  const now = Date.now();
  const articleId = await ctx.db.insert("articles", {
    issueId,
    order,
    title,
    source: "idml",
    reviewStatus: "approved",
    primaryPageIndex: page,
    pageStart: page,
    pageEnd: page,
    searchText: title,
    createdAt: now,
    updatedAt: now,
  });
  for (const [i, b] of blocks.entries()) {
    await ctx.db.insert("articleBlocks", {
      articleId,
      issueId,
      order: i + 1,
      type: "paragraph",
      text: b.text,
      sourcePageIndex: page,
      sourceStoryId: b.story,
    });
  }
  await ctx.db.insert("articleRegions", {
    articleId,
    issueId,
    pageIndex: page,
    x0: 0.05,
    y0: 0.1,
    x1: 0.95,
    y1: 0.5,
    kind: "body",
  });
  return articleId;
}

describe("Tabellen", () => {
  test("Import speichert die Tabelle, der Leser bekommt sie", async () => {
    const t = convexTest(schema, modules);
    const { issueId, adminId } = await heft(t);
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
      articles: [
        {
          order: 1,
          title: "Pour le Mérite",
          source: "idml",
          primaryPageIndex: 30,
          pageStart: 30,
          pageEnd: 31,
          blocks: [
            { order: 1, type: "paragraph", text: "Davor.", sourcePageIndex: 30 },
            {
              order: 2,
              type: "table",
              text: TEXT,
              table: TABELLE,
              sourcePageIndex: 31,
              sourceY: 0.46,
            },
          ],
          regions: [],
        },
      ],
    });
    const articleId = await t.run(async (ctx: any) => {
      const a = await ctx.db
        .query("articles")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .first();
      await ctx.db.patch(a._id, { reviewStatus: "approved" });
      return a._id;
    });
    const gelesen = await t
      .withIdentity({ subject: adminId, email: "admin@example.de" })
      .query(api.articles.getForReader, { articleId });
    expect(gelesen?.blocks.map((b: any) => b.type)).toEqual(["paragraph", "table"]);
    expect(gelesen?.blocks[0].table).toBeNull();
    expect(gelesen?.blocks[1].table).toEqual(TABELLE);
    // Die Zellen sind durchsuchbar.
    const such = await t.run(async (ctx: any) => (await ctx.db.get(articleId)).searchText);
    expect(such).toContain("Robert von Greim");
  });

  test("Tabellenblock laesst sich nicht als Text ueberschreiben", async () => {
    const t = convexTest(schema, modules);
    const { issueId, adminId } = await heft(t);
    const blockId = await t.run(async (ctx: any) => {
      const a = await artikel(ctx, issueId, 1, "A", 0, [{ text: "x" }]);
      return ctx.db.insert("articleBlocks", {
        articleId: a,
        issueId,
        order: 2,
        type: "table",
        text: TEXT,
        table: TABELLE,
      });
    });
    const asAdmin = t.withIdentity({ subject: adminId, email: "admin@example.de" });
    await expect(
      asAdmin.mutation(api.articles.updateBlock, { blockId, text: "anders" }),
    ).rejects.toThrow(/Tabellen/);
    await expect(
      asAdmin.mutation(api.articles.updateBlock, { blockId, type: "paragraph" }),
    ).rejects.toThrow(/Tabelle/);
  });

  test("Einsetzen ersetzt den Zellen-Artikel und laesst die anderen stehen", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const ids = await t.run(async (ctx: any) => {
      const plm = await artikel(ctx, issueId, 1, "Pour le Mérite", 30, [
        { text: "Eins" },
        { text: "Zwei" },
      ]);
      const zellen = await artikel(ctx, issueId, 2, "Nr.Name1Erwin Rommel", 31, [
        { text: "Nr.Name1Erwin Rommel", story: "ufb945" },
        { text: "Nr.", story: "ufb945" },
        { text: "Erwin Rommel", story: "ufb945" },
      ]);
      const danach = await artikel(ctx, issueId, 3, "Ungleicher Kampf", 32, [
        { text: "Mitte September 1943" },
      ]);
      const asset = await ctx.db.insert("assets", {
        key: "images/31.jpg",
        contentType: "image/jpeg",
        kind: "image",
        issueId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("articleAssets", {
        articleId: zellen,
        issueId,
        assetId: asset,
        order: 0,
        caption: "Erwin Rommel",
        sourcePageIndex: 31,
        sourceY: 0.55,
      });
      await ctx.db.insert("tocEntries", {
        issueId,
        order: 1,
        label: "Tabelle",
        articleId: zellen,
        level: 1,
      });
      return { plm, zellen, danach };
    });

    const einsetzen = {
      issueId,
      articleId: ids.plm,
      block: {
        text: TEXT,
        table: TABELLE,
        sourcePageIndex: 31,
        sourceY: 0.46,
        sourceStoryId: "ufb945",
        styleName: "mengentext schwerter",
      },
      ersetzt: ids.zellen,
    };
    const probe = await t.mutation(internal.tabellen.einsetzenInternal, {
      ...einsetzen,
      probelauf: true,
    });
    expect(probe).toMatchObject({ hinterBlock: 2, ersetzt: { bloecke: 3 } });
    const unveraendert = await t.run(async (ctx: any) => ctx.db.get(ids.zellen));
    expect(unveraendert).not.toBeNull();

    await t.mutation(internal.tabellen.einsetzenInternal, einsetzen);
    const stand = await t.run(async (ctx: any) => {
      const articles = await ctx.db
        .query("articles")
        .withIndex("by_issue_order", (q: any) => q.eq("issueId", issueId))
        .collect();
      const plmBloecke = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q: any) => q.eq("articleId", ids.plm))
        .collect();
      const alleBloecke = await ctx.db
        .query("articleBlocks")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const regionen = await ctx.db
        .query("articleRegions")
        .withIndex("by_article", (q: any) => q.eq("articleId", ids.plm))
        .collect();
      const bilder = await ctx.db
        .query("articleAssets")
        .withIndex("by_article", (q: any) => q.eq("articleId", ids.plm))
        .collect();
      const toc = await ctx.db
        .query("tocEntries")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const heft = await ctx.db.get(issueId);
      return { articles, plmBloecke, alleBloecke, regionen, bilder, toc, heft };
    });
    expect(stand.articles.map((a: any) => [a._id, a.order, a.reviewStatus])).toEqual([
      [ids.plm, 1, "approved"],
      [ids.danach, 2, "approved"],
    ]);
    expect(stand.heft.articleCount).toBe(2);
    expect(stand.plmBloecke.map((b: any) => [b.order, b.type])).toEqual([
      [1, "paragraph"],
      [2, "paragraph"],
      [3, "table"],
    ]);
    expect(stand.plmBloecke[2].table).toEqual(TABELLE);
    // Die losen Zellen sind weg, der Text des Nachbarn bleibt.
    expect(stand.alleBloecke).toHaveLength(4);
    expect(stand.regionen.map((r: any) => r.pageIndex).sort()).toEqual([30, 31]);
    expect(stand.bilder).toHaveLength(1);
    expect(stand.bilder[0].caption).toBe("Erwin Rommel");
    expect(stand.toc[0].articleId).toBe(ids.plm);
    const plm = stand.articles[0];
    expect([plm.pageStart, plm.pageEnd]).toEqual([30, 31]);
    expect(plm.searchText).toContain("Robert von Greim");

    // Ein zweiter Lauf aendert nichts.
    const nochmal = await t.mutation(internal.tabellen.einsetzenInternal, {
      ...einsetzen,
      ersetzt: undefined,
    });
    expect(nochmal).toEqual({ schonDa: true });
  });

  test("Einsetzen bricht ab, wenn der Artikel echten Text enthaelt", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const ids = await t.run(async (ctx: any) => ({
      plm: await artikel(ctx, issueId, 1, "Pour le Mérite", 30, [{ text: "Eins" }]),
      fremd: await artikel(ctx, issueId, 2, "Anderer Beitrag", 31, [
        { text: "Nr.", story: "ufb945" },
        { text: "Ein echter Absatz", story: "andere" },
      ]),
    }));
    await expect(
      t.mutation(internal.tabellen.einsetzenInternal, {
        issueId,
        articleId: ids.plm,
        block: {
          text: TEXT,
          table: TABELLE,
          sourcePageIndex: 31,
          sourceStoryId: "ufb945",
        },
        ersetzt: ids.fremd,
      }),
    ).rejects.toThrow(/ausserhalb der Tabelle/);
    const noch = await t.run(async (ctx: any) => ctx.db.get(ids.fremd));
    expect(noch?.title).toBe("Anderer Beitrag");
  });
});
