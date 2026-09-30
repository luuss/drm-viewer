import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function stored(t: ReturnType<typeof convexTest>, content: string) {
  return await t.run(
    async (ctx) => await ctx.storage.store(new Blob([content], { type: "application/pdf" })),
  );
}

describe("Heft per Kommandozeile anlegen", () => {
  test("Umschlag als Doppelseiten ergibt 84 Leserseiten aus halben Quellseiten", async () => {
    const t = convexTest(schema, modules);
    const inner = await stored(t, "innen");
    const cover = await stored(t, "umschlag");
    const archiveA = await stored(t, "indd-innen");
    const archiveB = await stored(t, "indd-umschlag");

    const result = await t.mutation(internal.devtools.seedIssueFromAssets, {
      publicationName: "Deutsche Militärzeitschrift",
      publicationSlug: "dmz",
      title: "DMZ 170",
      issueNumber: "170",
      priceAmountCents: 980,
      innerStorageId: inner,
      innerFilename: "dmz 170 innenteil.pdf",
      innerPageCount: 80,
      coverStorageId: cover,
      coverFilename: "umschlag dmz 170.pdf",
      coverPageCount: 2,
      archives: [
        { storageId: archiveA, filename: "dmz 170.indd" },
        { storageId: archiveB, filename: "umschlag dmz 170.indd" },
      ],
    });
    expect(result.pages).toBe(84);
    expect(result.publicationSlug).toBe("dmz");

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("issuePages")
        .withIndex("by_issue_index", (q) => q.eq("issueId", result.issueId))
        .collect(),
    );
    expect(rows).toHaveLength(84);
    expect(rows[0]).toMatchObject({ role: "front_cover", printedLabel: "U1", sourcePageIndex: 0, sourceHalf: "right" });
    expect(rows[1]).toMatchObject({ role: "inside_front", printedLabel: "U2", sourcePageIndex: 1, sourceHalf: "left" });
    expect(rows[2]).toMatchObject({ role: "content", printedLabel: "3", sourcePageIndex: 0 });
    expect(rows[2].sourceHalf).toBeUndefined();
    expect(rows[81]).toMatchObject({ role: "content", printedLabel: "82", sourcePageIndex: 79 });
    expect(rows[82]).toMatchObject({ role: "inside_back", printedLabel: "U3", sourcePageIndex: 1, sourceHalf: "right" });
    expect(rows[83]).toMatchObject({ role: "back_cover", printedLabel: "U4", sourcePageIndex: 0, sourceHalf: "left" });

    const publication = await t.run(async (ctx) =>
      ctx.db
        .query("publications")
        .withIndex("by_slug", (q) => q.eq("slug", "dmz"))
        .first(),
    );
    expect(publication?.name).toBe("Deutsche Militärzeitschrift");

    const sources = await t.run(async (ctx) =>
      ctx.db
        .query("issueSources")
        .withIndex("by_issue", (q) => q.eq("issueId", result.issueId))
        .collect(),
    );
    expect(sources.map((s) => [s.kind, s.role, s.filename]).sort()).toEqual([
      ["indd", "archive", "dmz 170.indd"],
      ["indd", "archive", "umschlag dmz 170.indd"],
      ["pdf", "cover", "umschlag dmz 170.pdf"],
      ["pdf", "inner", "dmz 170 innenteil.pdf"],
    ]);

    // Der Worker bekommt Kennung und Haelfte mit dem Auftrag.
    const job = await t.mutation(internal.imports.claimNextInternal, { workerId: "test" });
    expect(job?.publicationSlug).toBe("dmz");
    expect(job?.pages[0]).toMatchObject({ index: 0, sourcePageIndex: 0, sourceHalf: "right" });
    expect(job?.pages[2].sourceHalf).toBeNull();
    expect(job?.sources.filter((s) => s.kind === "indd")).toHaveLength(2);

    const status = await t.query(internal.devtools.jobStatusInternal, { jobId: result.jobId });
    expect(status).toMatchObject({ status: "claimed", pageCount: 84 });
  });

  test("ZUERST! bleibt ohne Kennung mit vier Einzelseiten erreichbar", async () => {
    const t = convexTest(schema, modules);
    const inner = await stored(t, "innen");
    const cover = await stored(t, "umschlag");
    const result = await t.mutation(internal.devtools.seedIssueFromAssets, {
      publicationName: "ZUERST!",
      title: "ZUERST! 3/2026",
      priceAmountCents: 999,
      innerStorageId: inner,
      innerFilename: "zuerst 3-2026 innenteil.pdf",
      innerPageCount: 80,
      coverStorageId: cover,
      coverFilename: "umschlag zuerst 3-2026.pdf",
      coverPageCount: 4,
    });
    expect(result.publicationSlug).toBe("zuerst");
    expect(result.pages).toBe(84);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("issuePages")
        .withIndex("by_issue_index", (q) => q.eq("issueId", result.issueId))
        .collect(),
    );
    expect(rows[0]).toMatchObject({ role: "front_cover", sourcePageIndex: 1 });
    expect(rows[0].sourceHalf).toBeUndefined();
    expect(rows[83]).toMatchObject({ role: "back_cover", sourcePageIndex: 0 });
  });
});

describe("Quellen einer Ausgabe", () => {
  async function fixture(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const publicationId = await ctx.db.insert("publications", {
        name: "Deutsche Militärzeitschrift",
        slug: "dmz",
        isActive: true,
        createdAt: now,
      });
      const issueId = await ctx.db.insert("issues", {
        publicationId,
        title: "DMZ 170",
        slug: "dmz-170",
        pageCount: 0,
        priceAmountCents: 980,
        isPublished: false,
        includedInSubscription: true,
        createdAt: now,
        updatedAt: now,
      });
      const asset = async (key: string) =>
        await ctx.db.insert("assets", {
          key,
          contentType: "application/octet-stream",
          kind: "source",
          issueId,
          createdAt: now,
        });
      const editorId = await ctx.db.insert("users", {
        email: "redaktion@example.de",
        roles: ["editor"],
      });
      return {
        issueId,
        editorId,
        innerIndd: await asset("a"),
        coverIndd: await asset("b"),
        innerInddAgain: await asset("c"),
        pdf: await asset("d"),
      };
    });
  }

  test("zwei Satzdateien bleiben nebeneinander, dieselbe Datei wird ersetzt", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const asEditor = t.withIdentity({ subject: f.editorId, email: "redaktion@example.de" });

    await asEditor.mutation(api.issueSources.add, {
      issueId: f.issueId, assetId: f.innerIndd, kind: "indd", role: "archive", filename: "dmz 170.indd",
    });
    await asEditor.mutation(api.issueSources.add, {
      issueId: f.issueId, assetId: f.coverIndd, kind: "indd", role: "archive", filename: "umschlag dmz 170.indd",
    });
    let list = await asEditor.query(api.issueSources.listForIssue, { issueId: f.issueId });
    expect(list.map((s) => s.filename).sort()).toEqual(["dmz 170.indd", "umschlag dmz 170.indd"]);

    await asEditor.mutation(api.issueSources.add, {
      issueId: f.issueId, assetId: f.innerInddAgain, kind: "indd", role: "archive", filename: "dmz 170.indd",
    });
    list = await asEditor.query(api.issueSources.listForIssue, { issueId: f.issueId });
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.filename === "dmz 170.indd")?.assetId).toBe(f.innerInddAgain);
  });

  test("Leserreihenfolge behaelt die Seitenhaelfte", async () => {
    const t = convexTest(schema, modules);
    const f = await fixture(t);
    const asEditor = t.withIdentity({ subject: f.editorId, email: "redaktion@example.de" });
    const n = await asEditor.mutation(api.issuePages.setOrder, {
      issueId: f.issueId,
      pages: [
        { sourceAssetId: f.pdf, sourcePageIndex: 0, sourceHalf: "right", role: "front_cover", printedLabel: "U1" },
        { sourceAssetId: f.pdf, sourcePageIndex: 1, role: "content", printedLabel: "3" },
      ],
    });
    expect(n).toBe(2);
    const pages = await asEditor.query(api.issuePages.debugForEditors, { issueId: f.issueId });
    expect(pages[0]).toMatchObject({ index: 0, sourcePageIndex: 0, sourceHalf: "right" });
    expect(pages[1]).toMatchObject({ index: 1, sourcePageIndex: 1, sourceHalf: null });
  });
});

describe("Bilder per Kommandozeile aus Artikeln nehmen", () => {
  async function artikelMitBildern(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
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
        pageCount: 65,
        priceAmountCents: 990,
        isPublished: false,
        includedInSubscription: true,
        createdAt: now,
        updatedAt: now,
      });
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Standartenführer Alfons Rebane",
        source: "idml",
        reviewStatus: "approved",
        primaryPageIndex: 9,
        pageStart: 9,
        pageEnd: 12,
        searchText: "Rebane",
        createdAt: now,
        updatedAt: now,
      });
      const bilder = [];
      for (const [i, caption] of [undefined, "Rebane als Oberleutnant", undefined].entries()) {
        const assetId = await ctx.db.insert("assets", {
          key: `images/9-${i}.jpg`,
          contentType: "image/jpeg",
          kind: "image",
          issueId,
          createdAt: now,
        });
        bilder.push(
          await ctx.db.insert("articleAssets", { articleId, issueId, assetId, order: i, caption }),
        );
      }
      return { issueId, articleId, bilder };
    });
  }

  test("Rahmen faellt weg, seine Bildunterschrift geht an das Foto", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId, bilder } = await artikelMitBildern(t);
    const [aufmacher, rahmen, foto] = bilder;
    const remove = [{ id: rahmen, captionTo: foto }];

    const probe = await t.mutation(internal.devtools.removeArticleImagesInternal, {
      issueId,
      remove,
      probelauf: true,
    });
    expect(probe).toEqual({ removed: 1, captionsMoved: 1, articles: 1, probelauf: true });
    expect(await t.run(async (ctx) => await ctx.db.get(rahmen))).not.toBeNull();

    const result = await t.mutation(internal.devtools.removeArticleImagesInternal, { issueId, remove });
    expect(result).toEqual({ removed: 1, captionsMoved: 1, articles: 1, probelauf: false });

    const rest = await t.run(async (ctx) =>
      ctx.db
        .query("articleAssets")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .collect(),
    );
    expect(rest.map((r) => [r._id, r.order, r.caption])).toEqual([
      [aufmacher, 0, undefined],
      [foto, 1, "Rebane als Oberleutnant"],
    ]);

    // Wiederholbar: beim zweiten Lauf ist nichts mehr zu tun.
    const nochmal = await t.mutation(internal.devtools.removeArticleImagesInternal, { issueId, remove });
    expect(nochmal.removed).toBe(0);
  });

  test("Bild einer anderen Ausgabe bricht ab", async () => {
    const t = convexTest(schema, modules);
    const { bilder } = await artikelMitBildern(t);
    const fremd = await t.run(async (ctx) => {
      const publicationId = (await ctx.db.query("publications").first())!._id;
      return await ctx.db.insert("issues", {
        publicationId,
        title: "Anderes Heft",
        slug: "anderes-heft",
        pageCount: 1,
        priceAmountCents: 990,
        isPublished: false,
        includedInSubscription: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      t.mutation(internal.devtools.removeArticleImagesInternal, {
        issueId: fremd,
        remove: [{ id: bilder[0] }],
      }),
    ).rejects.toThrow(/gehoert nicht zu dieser Ausgabe/);
  });
});

describe("Absaetze per Kommandozeile aus Artikeln nehmen", () => {
  async function artikelMitZungen(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
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
        pageCount: 65,
        priceAmountCents: 990,
        isPublished: false,
        includedInSubscription: true,
        createdAt: now,
        updatedAt: now,
      });
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Warschauer Aufstand 1944",
        source: "idml",
        reviewStatus: "approved",
        primaryPageIndex: 20,
        pageStart: 20,
        pageEnd: 23,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
      // Seite 22 traegt nur die Zunge, etwa neben einem ganzseitigen Bild.
      const absaetze: [string, number, string][] = [
        ["Die Panzerschlacht vor Warschau begann am 1. August.", 20, "Mengentext DMZ-Zeit 2018"],
        ["Das 3. Panzerkorps war völlig aufgerieben worden.", 21, "Mengentext DMZ-Zeit 2018"],
        ["Russische Panzerkorps", 21, "Zungentext DMZ-Zeit 2018"],
        ["schwer angeschlagen", 21, "Zungentext DMZ-Zeit 2018"],
        ["Heftige deutsche Gegenangriffe", 22, "Zungentext DMZ-Zeit 2018"],
        ["Am Abend des 31. Juli gab Komorowski den Befehl.", 23, "Mengentext DMZ-Zeit 2018"],
      ];
      const bloecke = [];
      for (const [i, [text, sourcePageIndex, styleName]] of absaetze.entries()) {
        bloecke.push(
          await ctx.db.insert("articleBlocks", {
            articleId,
            issueId,
            order: i + 1,
            type: "paragraph",
            text,
            sourcePageIndex,
            styleName,
          }),
        );
      }
      const bilder = [];
      for (const [i, [sourcePageIndex, afterBlockOrder]] of [
        [21, 4],
        [22, 5],
        [23, 6],
        [20, 1],
      ].entries()) {
        const assetId = await ctx.db.insert("assets", {
          key: `images/${sourcePageIndex}-${i}.jpg`,
          contentType: "image/jpeg",
          kind: "image",
          issueId,
          createdAt: now,
        });
        bilder.push(
          await ctx.db.insert("articleAssets", {
            articleId,
            issueId,
            assetId,
            order: i,
            sourcePageIndex,
            afterBlockOrder,
          }),
        );
      }
      return { issueId, articleId, bloecke, bilder };
    });
  }

  test("Zungen fallen weg, Reihenfolge und Bildanker ruecken nach", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId, bloecke, bilder } = await artikelMitZungen(t);
    const remove = [bloecke[2], bloecke[3], bloecke[4]];

    const probe = await t.mutation(internal.devtools.removeArticleBlocksInternal, {
      issueId,
      remove,
      probelauf: true,
    });
    expect(probe).toEqual({ removed: 3, articles: 1, imagesMoved: 3, probelauf: true });
    expect(await t.run(async (ctx) => await ctx.db.get(bloecke[2]))).not.toBeNull();

    const result = await t.mutation(internal.devtools.removeArticleBlocksInternal, { issueId, remove });
    expect(result).toEqual({ removed: 3, articles: 1, imagesMoved: 3, probelauf: false });

    const rest = await t.run(async (ctx) =>
      ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
        .collect(),
    );
    expect(rest.map((b) => [b._id, b.order])).toEqual([
      [bloecke[0], 1],
      [bloecke[1], 2],
      [bloecke[5], 3],
    ]);

    const anker = await t.run(async (ctx) =>
      Promise.all(bilder.map(async (id) => (await ctx.db.get(id))?.afterBlockOrder ?? null)),
    );
    // Hinter der Zunge: jetzt hinter dem Absatz davor auf derselben Seite.
    // Allein mit der Zunge auf der Seite: ohne Anker. Dahinter: rueckt nach.
    expect(anker).toEqual([2, null, 3, 1]);

    const article = await t.run(async (ctx) => await ctx.db.get(articleId));
    expect(article?.searchText).toContain("völlig aufgerieben");
    expect(article?.searchText).not.toContain("schwer angeschlagen");

    // Wiederholbar: beim zweiten Lauf ist nichts mehr zu tun.
    const nochmal = await t.mutation(internal.devtools.removeArticleBlocksInternal, { issueId, remove });
    expect(nochmal.removed).toBe(0);
  });

  test("Absatz einer anderen Ausgabe bricht ab", async () => {
    const t = convexTest(schema, modules);
    const { bloecke } = await artikelMitZungen(t);
    const fremd = await t.run(async (ctx) => {
      const publicationId = (await ctx.db.query("publications").first())!._id;
      return await ctx.db.insert("issues", {
        publicationId,
        title: "Anderes Heft",
        slug: "anderes-heft",
        pageCount: 1,
        priceAmountCents: 990,
        isPublished: false,
        includedInSubscription: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      t.mutation(internal.devtools.removeArticleBlocksInternal, {
        issueId: fremd,
        remove: [bloecke[2]],
      }),
    ).rejects.toThrow(/gehoert nicht zu dieser Ausgabe/);
  });
});
