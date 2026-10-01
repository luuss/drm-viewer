import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

/**
 * Ein veroeffentlichtes Heft mit gedrucktem Verzeichnis auf Leserseite 3 und
 * einer Artikelseite 7. Beide Seiten sind gerendert; nur die Verzeichnisseite
 * darf ohne Lesesitzung heraus.
 */
async function heft(t: any, { published = true } = {}) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "DMZ",
      slug: `dmz-${Math.random().toString(36).slice(2)}`,
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "DMZ 170",
      slug: `dmz-170-${Math.random().toString(36).slice(2)}`,
      pageCount: 10,
      priceAmountCents: 980,
      isPublished: published,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const quelle = await ctx.db.insert("assets", {
      key: `quelle-${issueId}`,
      contentType: "application/pdf",
      kind: "source",
      issueId,
      createdAt: now,
    });
    const seite = async (index: number, printedLabel: string) => {
      const key = `pages/${issueId}/${index}/full.jpg`;
      const assetId = await ctx.db.insert("assets", {
        key,
        bucket: "emag-media",
        contentType: "image/jpeg",
        kind: "page",
        issueId,
        width: 2400,
        height: 3200,
        createdAt: now,
      });
      await ctx.db.insert("issuePages", {
        issueId,
        index,
        printedLabel,
        role: "content",
        sourceAssetId: quelle,
        sourcePageIndex: index,
        width: 2400,
        height: 3200,
        previewKey: key,
      });
      return assetId;
    };
    const verzeichnis = await seite(3, "3");
    const artikelseite = await seite(7, "7");
    const articleId = await ctx.db.insert("articles", {
      issueId,
      order: 1,
      title: "Die Schlacht von Carpiquet",
      subtitle: "Kanadier gegen die Hitlerjugend im Juli 1944",
      source: "idml",
      reviewStatus: "approved",
      primaryPageIndex: 7,
      pageStart: 7,
      pageEnd: 8,
      searchText: "Die Schlacht von Carpiquet",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("articleRegions", {
      issueId,
      articleId,
      pageIndex: 3,
      x0: 0.1,
      y0: 0.2,
      x1: 0.5,
      y1: 0.25,
      kind: "other",
      targetPageIndex: 7,
      order: 0,
    });
    await ctx.db.insert("articleRegions", {
      issueId,
      articleId,
      pageIndex: 7,
      x0: 0.05,
      y0: 0.05,
      x1: 0.95,
      y1: 0.95,
      kind: "body",
      order: 1,
    });
    await ctx.db.insert("tocEntries", {
      issueId,
      order: 1,
      label: "Die Schlacht von Carpiquet",
      pageIndex: 7,
      articleId,
      level: 1,
    });
    return { issueId, verzeichnis, artikelseite };
  });
}

describe("Inhaltsverzeichnis in der Heftvorschau", () => {
  test("nur die Verzeichnisseite eines veroeffentlichten Hefts ist frei", async () => {
    const t = convexTest(schema, modules);
    const { verzeichnis, artikelseite } = await heft(t);
    const frei = await t.query(internal.assets.resolveForServiceInternal, {
      assetId: verzeichnis,
    });
    expect(frei?.public).toBe(true);
    const gesperrt = await t.query(internal.assets.resolveForServiceInternal, {
      assetId: artikelseite,
    });
    expect(gesperrt?.public).toBe(false);

    const entwurf = await heft(t, { published: false });
    const unveroeffentlicht = await t.query(internal.assets.resolveForServiceInternal, {
      assetId: entwurf.verzeichnis,
    });
    expect(unveroeffentlicht?.public).toBe(false);
  });

  test("die Vorschau liefert das Verzeichnis als Bild", async () => {
    process.env.PUBLIC_TILE_ORIGIN = "https://lesen.example.test";
    const t = convexTest(schema, modules);
    const { issueId, verzeichnis } = await heft(t);
    const issue = await t.query(api.issues.getPublic, { issueId });
    expect(issue?.tocImages).toEqual([
      {
        pageIndex: 3,
        url: `https://lesen.example.test/api/asset/${verzeichnis}.jpg`,
        width: 2400,
        height: 3200,
      },
    ]);
  });

  test("die Kiosk-Suche findet Verzeichniseintraege ungekaufter Hefte", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    await heft(t, { published: false });
    const treffer = await t.query(api.tocPreview.searchCatalog, { term: "Carpiquet" });
    expect(treffer).toHaveLength(1);
    expect(treffer[0]._id).toBe(issueId);
    expect(treffer[0].entries.map((e: any) => [e.label, e.page])).toEqual([
      ["Die Schlacht von Carpiquet", "7"],
    ]);
    expect(await t.query(api.tocPreview.searchCatalog, { term: "Ca" })).toEqual([]);
    // Die Unterzeile aus dem gedruckten Verzeichnis zaehlt mit.
    const unterzeile = await t.query(api.tocPreview.searchCatalog, { term: "Hitlerjugend" });
    expect(unterzeile.map((h: any) => h.entries[0].label)).toEqual([
      "Die Schlacht von Carpiquet",
    ]);
    expect(unterzeile[0].entries[0].subtitle).toBe(
      "Kanadier gegen die Hitlerjugend im Juli 1944",
    );
  });
});
