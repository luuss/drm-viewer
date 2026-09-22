import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function base(t: any) {
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
      pageCount: 6,
      priceAmountCents: 999,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("issuePages", {
      issueId,
      index: 0,
      role: "content",
      sourceAssetId: await ctx.db.insert("assets", {
        key: "k",
        contentType: "application/pdf",
        kind: "source",
        createdAt: now,
      }),
      sourcePageIndex: 0,
      width: 100,
      height: 100,
    });
    const editorId = await ctx.db.insert("users", {
      email: "redaktion@example.de",
      roles: ["publisher"],
    });
    return { publicationId, issueId, editorId };
  });
}

function article(order: number, page: number, blocks: string[]) {
  return {
    order,
    title: blocks[0],
    source: "pdf" as const,
    primaryPageIndex: page,
    pageStart: page,
    pageEnd: page,
    blocks: blocks.map((text, i) => ({
      order: i + 1,
      type: i === 0 ? ("heading" as const) : ("paragraph" as const),
      text,
      sourcePageIndex: page,
      sourceY: Number((0.1 + i * 0.2).toFixed(2)),
    })),
    regions: [
      { pageIndex: page, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5, kind: "body" as const },
    ],
  };
}

describe("Artikeloperationen", () => {
  test("Import legt Entwuerfe an und baut den Suchtext", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await base(t);
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
    const imageAssetId = await t.run(async (ctx: any) =>
      ctx.db.insert("assets", {
        key: "images/test.jpg",
        contentType: "image/jpeg",
        kind: "image",
        issueId,
        createdAt: Date.now(),
      }),
    );
    const first = {
      ...article(1, 0, ["Titel A", "Absatz eins"]),
      source: "hybrid" as const,
      images: [{
        assetId: imageAssetId,
        caption: "Passendes Bild",
        sourcePageIndex: 0,
        sourceY: 0.4,
        afterBlockOrder: 2,
      }],
    };
    const result = await t.mutation(internal.imports.activateResultInternal, {
      jobId,
      workerId: "w1",
      issueId,
      articles: [first, article(2, 1, ["Titel B", "Absatz zwei"])],
    });
    expect(result.articles).toBe(2);
    expect(result.toc).toBe(2);

    const imported = await t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("articles")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const images = await ctx.db
        .query("articleAssets")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      return { rows, blocks, images };
    });
    const rows = imported.rows;
    expect(rows.every((r: any) => r.reviewStatus === "pending")).toBe(true);
    expect(rows[0].searchText).toContain("Absatz eins");
    expect(imported.blocks.map((b: any) => b.sourceY)).toEqual([0.1, 0.3, 0.1, 0.3]);
    expect(imported.images[0].afterBlockOrder).toBe(2);
  });

  test("Re-Import ersetzt alle abgeleiteten Daten", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await base(t);
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
      articles: [article(1, 0, ["Alt", "Alttext"])],
    });
    await t.mutation(internal.imports.activateResultInternal, {
      jobId,
      workerId: "w1",
      issueId,
      articles: [article(1, 0, ["Neu", "Neutext"]), article(2, 1, ["Neu2", "Mehr"])],
    });
    const counts = await t.run(async (ctx: any) => {
      const articles = await ctx.db
        .query("articles")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      const regions = await ctx.db
        .query("articleRegions")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      return { articles: articles.length, blocks: blocks.length, regions: regions.length, titles: articles.map((a: any) => a.title) };
    });
    expect(counts.articles).toBe(2);
    expect(counts.titles).toEqual(["Neu", "Neu2"]);
    expect(counts.blocks).toBe(4);
    expect(counts.regions).toBe(2);
  });

  test("Trennen an der Blockgrenze verteilt Bloecke und Regionen", async () => {
    const t = convexTest(schema, modules);
    const { issueId, editorId } = await base(t);
    const ids = await t.run(async (ctx: any) => {
      const now = Date.now();
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Zusammen",
        source: "pdf",
        reviewStatus: "pending",
        primaryPageIndex: 0,
        pageStart: 0,
        pageEnd: 1,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
      const blockIds = [];
      for (const [i, spec] of [
        ["Teil eins", 0],
        ["Noch eins", 0],
        ["Teil zwei", 1],
      ].entries()) {
        blockIds.push(
          await ctx.db.insert("articleBlocks", {
            articleId,
            issueId,
            order: i + 1,
            type: "paragraph",
            text: spec[0] as string,
            sourcePageIndex: spec[1] as number,
          }),
        );
      }
      for (const page of [0, 1]) {
        await ctx.db.insert("articleRegions", {
          articleId,
          issueId,
          pageIndex: page,
          x0: 0,
          y0: 0,
          x1: 1,
          y1: 1,
          kind: "body",
        });
      }
      return { articleId, blockIds };
    });

    const asEditor = t.withIdentity({ subject: editorId, email: "redaktion@example.de" });
    await asEditor.mutation(await import("./_generated/api").then((m) => m.api.articles.splitAtBlock), {
      articleId: ids.articleId,
      firstBlockOfSecond: ids.blockIds[2],
      newTitle: "Fortsetzung",
    });

    const state = await t.run(async (ctx: any) => {
      const articles = await ctx.db
        .query("articles")
        .withIndex("by_issue_order", (q: any) => q.eq("issueId", issueId))
        .collect();
      const out = [];
      for (const a of articles) {
        const blocks = await ctx.db
          .query("articleBlocks")
          .withIndex("by_article", (q: any) => q.eq("articleId", a._id))
          .collect();
        const regions = await ctx.db
          .query("articleRegions")
          .withIndex("by_article", (q: any) => q.eq("articleId", a._id))
          .collect();
        out.push({
          title: a.title,
          order: a.order,
          blocks: blocks.length,
          regionPages: regions.map((r: any) => r.pageIndex).sort(),
        });
      }
      return out;
    });

    expect(state.length).toBe(2);
    expect(state[0].blocks).toBe(2);
    expect(state[1].blocks).toBe(1);
    // Die Region der zweiten Seite wandert mit, sie wird nicht dupliziert.
    expect(state[0].regionPages).toEqual([0]);
    expect(state[1].regionPages).toEqual([1]);
    expect(state.map((s) => s.order)).toEqual([1, 2]);
  });

  test("Zusammenfuehren haengt die Bloecke hinten an", async () => {
    const t = convexTest(schema, modules);
    const { issueId, editorId } = await base(t);
    const ids = await t.run(async (ctx: any) => {
      const now = Date.now();
      const make = async (title: string, order: number, text: string) => {
        const id = await ctx.db.insert("articles", {
          issueId,
          order,
          title,
          source: "pdf",
          reviewStatus: "pending",
          primaryPageIndex: 0,
          pageStart: 0,
          pageEnd: 0,
          searchText: "",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("articleBlocks", {
          articleId: id,
          issueId,
          order: 1,
          type: "paragraph",
          text,
          sourcePageIndex: 0,
        });
        return id;
      };
      return { a: await make("Erster", 1, "Text A"), b: await make("Zweiter", 2, "Text B") };
    });

    const { api } = await import("./_generated/api");
    const asEditor = t.withIdentity({ subject: editorId, email: "redaktion@example.de" });
    await asEditor.mutation(api.articles.mergeArticles, { targetId: ids.a, sourceId: ids.b });

    const merged = await t.run(async (ctx: any) => {
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q: any) => q.eq("articleId", ids.a))
        .collect();
      const article = await ctx.db.get(ids.a);
      return { texts: blocks.map((b: any) => b.text), searchText: article.searchText };
    });
    expect(merged.texts).toEqual(["Text A", "Text B"]);
    expect(merged.searchText).toContain("Text B");
  });

  test("Klickflaechen kommen sortiert und beschnitten beim Leser an", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await base(t);
    const leserId = await t.run(async (ctx: any) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { email: "leser@example.de" });
      await ctx.db.insert("entitlements", {
        userId,
        issueId,
        source: "purchase",
        createdAt: now,
      });
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Artikel",
        source: "pdf",
        reviewStatus: "approved",
        primaryPageIndex: 0,
        pageStart: 0,
        pageEnd: 0,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
      // verdreht und ueberstehend, wie es die Aufbereitung vereinzelt liefert
      await ctx.db.insert("articleRegions", {
        articleId,
        issueId,
        pageIndex: 0,
        x0: 1.2,
        y0: 0.1,
        x1: 0.6,
        y1: 0.4,
        kind: "title",
      });
      // Zweiter Teil desselben Artikels: kommt im Reader als eine gemeinsame
      // ruhige Flaeche an, nicht als weiterer schmaler Streifen.
      await ctx.db.insert("articleRegions", {
        articleId,
        issueId,
        pageIndex: 0,
        x0: 0.2,
        y0: 0.35,
        x1: 0.8,
        y1: 0.9,
        kind: "body",
      });
      // entartet: ohne Breite, taugt nur als unsichtbare Fehlklickflaeche
      await ctx.db.insert("articleRegions", {
        articleId,
        issueId,
        pageIndex: 0,
        x0: 0.5,
        y0: 0.5,
        x1: 0.5,
        y1: 0.9,
        kind: "body",
      });
      // Ein Inhaltsverzeichnis-Ziel bleibt trotz desselben Artikels separat.
      await ctx.db.insert("articleRegions", {
        articleId,
        issueId,
        pageIndex: 0,
        x0: 0.1,
        y0: 0.92,
        x1: 0.4,
        y1: 0.98,
        kind: "other",
        targetPageIndex: 5,
      });
      return userId;
    });

    const { api } = await import("./_generated/api");
    const regions = await t
      .withIdentity({ subject: leserId, email: "leser@example.de" })
      .query(api.articles.regionsForReader, { issueId });

    expect(regions).toHaveLength(2);
    const area = regions.find((region) => region.targetPageIndex === null)!;
    const jump = regions.find((region) => region.targetPageIndex === 5)!;
    expect(area.x0).toBeCloseTo(0.2);
    expect(area.x1).toBeCloseTo(1);
    expect(area.y0).toBeCloseTo(0.1);
    expect(area.y1).toBeCloseTo(0.9);
    expect(jump.x0).toBeCloseTo(0.1);
  });

  test("Sammelfreigabe gibt offene Artikel frei und laesst Ausgeschlossene in Ruhe", async () => {
    const t = convexTest(schema, modules);
    const { issueId, editorId } = await base(t);
    await t.run(async (ctx: any) => {
      const now = Date.now();
      const make = async (order: number, title: string, reviewStatus: string) =>
        await ctx.db.insert("articles", {
          issueId,
          order,
          title,
          source: "pdf",
          reviewStatus,
          primaryPageIndex: 0,
          pageStart: 0,
          pageEnd: 0,
          searchText: "",
          createdAt: now,
          updatedAt: now,
        });
      await make(1, "Offen A", "pending");
      await make(2, "Offen B", "pending");
      await make(3, "Raus", "excluded");
      await make(4, "Schon frei", "approved");
    });

    const { api } = await import("./_generated/api");
    const asEditor = t.withIdentity({ subject: editorId, email: "redaktion@example.de" });
    const result = await asEditor.mutation(api.articles.approveAllPending, { issueId });
    expect(result).toEqual({ approved: 2, remaining: false });

    const state = await t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("articles")
        .withIndex("by_issue_order", (q: any) => q.eq("issueId", issueId))
        .collect();
      const issue = await ctx.db.get(issueId);
      const log = await ctx.db.query("auditLog").collect();
      return {
        status: rows.map((r: any) => [r.title, r.reviewStatus]),
        articleCount: issue.articleCount,
        actions: log.map((entry: any) => entry.action),
      };
    });
    expect(state.status).toEqual([
      ["Offen A", "approved"],
      ["Offen B", "approved"],
      // Ausgeschlossene Artikel bleiben ausgeschlossen, sonst waere die
      // redaktionelle Entscheidung mit einem Klick weg.
      ["Raus", "excluded"],
      ["Schon frei", "approved"],
    ]);
    // Der Zaehler am Heft haengt an der Anzahl, nicht am Status.
    expect(state.articleCount).toBeUndefined();
    expect(state.actions).toContain("article.review.approveAll");

    // Zweiter Aufruf findet nichts mehr und meldet das auch so.
    const zweiter = await asEditor.mutation(api.articles.approveAllPending, { issueId });
    expect(zweiter).toEqual({ approved: 0, remaining: false });
  });

  test("Sammelfreigabe verlangt Redaktionsrechte", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await base(t);
    const leserId = await t.run(async (ctx: any) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { email: "leser@example.de" });
      await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Offen",
        source: "pdf",
        reviewStatus: "pending",
        primaryPageIndex: 0,
        pageStart: 0,
        pageEnd: 0,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });

    const { api } = await import("./_generated/api");
    await expect(
      t
        .withIdentity({ subject: leserId, email: "leser@example.de" })
        .mutation(api.articles.approveAllPending, { issueId }),
    ).rejects.toThrow(/Berechtigung/i);

    const status = await t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("articles")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      return rows.map((r: any) => r.reviewStatus);
    });
    expect(status).toEqual(["pending"]);
  });

  test("Veroeffentlichen erst, wenn alle Artikel entschieden sind", async () => {
    const t = convexTest(schema, modules);
    const { issueId, editorId } = await base(t);
    await t.run(async (ctx: any) => {
      const now = Date.now();
      await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Offen",
        source: "pdf",
        reviewStatus: "pending",
        primaryPageIndex: 0,
        pageStart: 0,
        pageEnd: 0,
        searchText: "",
        createdAt: now,
        updatedAt: now,
      });
    });
    const { api } = await import("./_generated/api");
    const asPublisher = t.withIdentity({ subject: editorId, email: "redaktion@example.de" });
    await expect(
      asPublisher.mutation(api.issues.setPublished, { issueId, isPublished: true }),
    ).rejects.toThrow(/ohne Entscheidung/i);

    await asPublisher.mutation(api.articles.approveAllPending, { issueId });
    await asPublisher.mutation(api.issues.setPublished, { issueId, isPublished: true });
    const issue = await t.run(async (ctx: any) => await ctx.db.get(issueId));
    expect(issue.isPublished).toBe(true);
  });
});
