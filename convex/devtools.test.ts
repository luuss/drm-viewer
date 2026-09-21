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
