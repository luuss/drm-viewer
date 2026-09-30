import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

/** Ein Heft mit U1 und zwei Innenseiten samt allem, was Seiten zaehlt. */
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
      pageCount: 3,
      priceAmountCents: 980,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const asset = async (key: string) =>
      await ctx.db.insert("assets", {
        key,
        contentType: "image/jpeg",
        kind: "page",
        issueId,
        width: 2400,
        height: 3394,
        createdAt: now,
      });
    const seiten = [
      { role: "front_cover", printedLabel: "U1" },
      { role: "content", printedLabel: "3" },
      { role: "content", printedLabel: "4" },
    ];
    for (const [i, s] of seiten.entries()) {
      await ctx.db.insert("issuePages", {
        issueId,
        index: i,
        role: s.role,
        printedLabel: s.printedLabel,
        sourceAssetId: await asset(`seite-${i}`),
        sourcePageIndex: i,
        width: 2400,
        height: 3394,
        previewKey: `seite-${i}`,
      });
    }
    const articleId = await ctx.db.insert("articles", {
      issueId,
      order: 1,
      title: "Artikel",
      source: "idml",
      reviewStatus: "approved",
      primaryPageIndex: 1,
      pageStart: 1,
      pageEnd: 2,
      searchText: "",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("articleBlocks", {
      articleId,
      issueId,
      order: 1,
      type: "paragraph",
      text: "Text",
      sourcePageIndex: 2,
    });
    await ctx.db.insert("articleRegions", {
      articleId,
      issueId,
      pageIndex: 1,
      x0: 0.1,
      y0: 0.1,
      x1: 0.4,
      y1: 0.2,
      kind: "other",
      targetPageIndex: 2,
      order: 0,
    });
    await ctx.db.insert("articleRegions", {
      articleId,
      issueId,
      pageIndex: 0,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
      kind: "body",
      order: 1,
    });
    await ctx.db.insert("articleAssets", {
      articleId,
      issueId,
      assetId: await asset("bild"),
      order: 0,
      sourcePageIndex: 2,
    });
    await ctx.db.insert("tocEntries", {
      issueId,
      order: 1,
      label: "Artikel",
      pageIndex: 2,
      articleId,
      level: 1,
    });
    const userId = await ctx.db.insert("users", { email: "leser@example.de", roles: [] });
    await ctx.db.insert("readingProgress", {
      userId,
      issueId,
      mode: "page",
      pageIndex: 2,
      updatedAt: now,
    });
    return { issueId, articleId, u2: await asset("u2"), u3: await asset("u3"), u4: await asset("u4") };
  });
}

describe("Seiten einfuegen", () => {
  test("U2 vorn: alles ab Seite 1 rueckt nach, U3 und U4 haengen hinten an", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId, u2, u3, u4 } = await heft(t);

    const vorn = await t.mutation(internal.issuePages.insertInternal, {
      issueId,
      at: 1,
      pages: [
        { role: "inside_front", printedLabel: "U2", sourceAssetId: u2, sourcePageIndex: 1, previewKey: "u2", width: 2400, height: 3394 },
      ],
    });
    // Zwei Seiten, der Artikel, ein Absatz, ein Bildanker, die Sprungflaeche,
    // der Verzeichniseintrag und der Lesestand ruecken nach.
    expect(vorn).toEqual({ inserted: 1, shifted: 2 + 1 + 1 + 1 + 1 + 1 + 1, pageCount: 4 });

    const hinten = await t.mutation(internal.issuePages.insertInternal, {
      issueId,
      at: 4,
      pages: [
        { role: "inside_back", printedLabel: "U3", sourceAssetId: u3, sourcePageIndex: 2, previewKey: "u3", width: 2400, height: 3394 },
        { role: "back_cover", printedLabel: "U4", sourceAssetId: u4, sourcePageIndex: 3, previewKey: "u4", width: 2400, height: 3394 },
      ],
    });
    expect(hinten).toEqual({ inserted: 2, shifted: 0, pageCount: 6 });

    const stand = await t.run(async (ctx: any) => {
      const pages = await ctx.db
        .query("issuePages")
        .withIndex("by_issue_index", (q: any) => q.eq("issueId", issueId))
        .collect();
      const article = await ctx.db.get(articleId);
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const regions = await ctx.db
        .query("articleRegions")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const assets = await ctx.db
        .query("articleAssets")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const toc = await ctx.db
        .query("tocEntries")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const progress = await ctx.db.query("readingProgress").collect();
      const issue = await ctx.db.get(issueId);
      return { pages, article, blocks, regions, assets, toc, progress, issue };
    });
    expect(stand.pages.map((p: any) => [p.index, p.printedLabel])).toEqual([
      [0, "U1"],
      [1, "U2"],
      [2, "3"],
      [3, "4"],
      [4, "U3"],
      [5, "U4"],
    ]);
    expect([stand.article.primaryPageIndex, stand.article.pageStart, stand.article.pageEnd]).toEqual([2, 2, 3]);
    expect(stand.blocks[0].sourcePageIndex).toBe(3);
    const sprung = stand.regions.find((r: any) => r.targetPageIndex !== undefined);
    expect([sprung.pageIndex, sprung.targetPageIndex]).toEqual([2, 3]);
    // Die Flaeche auf der Titelseite bleibt, wo sie ist.
    expect(stand.regions.find((r: any) => r.kind === "body").pageIndex).toBe(0);
    expect(stand.assets[0].sourcePageIndex).toBe(3);
    expect(stand.toc[0].pageIndex).toBe(3);
    expect(stand.progress[0].pageIndex).toBe(3);
    expect(stand.issue.pageCount).toBe(6);
  });

  test("weist eine Einfuegestelle hinter dem Ende ab", async () => {
    const t = convexTest(schema, modules);
    const { issueId, u2 } = await heft(t);
    await expect(
      t.mutation(internal.issuePages.insertInternal, {
        issueId,
        at: 9,
        pages: [
          { role: "inside_front", sourceAssetId: u2, sourcePageIndex: 0, width: 1, height: 1 },
        ],
      }),
    ).rejects.toThrow(/ausserhalb/);
  });
});
