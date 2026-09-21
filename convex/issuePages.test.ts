import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function fixture(t: ReturnType<typeof convexTest>) {
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
      title: "ZUERST! 3/2026",
      slug: "zuerst-3-2026-debug",
      pageCount: 1,
      priceAmountCents: 999,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const sourceAssetId = await ctx.db.insert("assets", {
      key: "source/zuerst.pdf",
      contentType: "application/pdf",
      kind: "source",
      issueId,
      createdAt: now,
    });
    await ctx.db.insert("issuePages", {
      issueId,
      index: 0,
      printedLabel: "U1",
      role: "front_cover",
      sourceAssetId,
      sourcePageIndex: 1,
      width: 1200,
      height: 1600,
      previewKey: "pages/cover.jpg",
    });
    const editorId = await ctx.db.insert("users", {
      email: "redaktion@example.de",
      roles: ["editor"],
    });
    return { issueId, editorId, sourceAssetId };
  });
}

describe("Extraktions-Debugseiten", () => {
  test("sind nur fuer die Redaktion sichtbar", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await fixture(t);
    await expect(t.query(api.issuePages.debugForEditors, { issueId })).rejects.toThrow(
      "Nicht angemeldet",
    );
  });

  test("behalten Quellseite, Rolle und Rohmasse bei", async () => {
    const t = convexTest(schema, modules);
    const { issueId, editorId, sourceAssetId } = await fixture(t);
    const asEditor = t.withIdentity({
      subject: editorId,
      email: "redaktion@example.de",
    });
    const pages = await asEditor.query(api.issuePages.debugForEditors, { issueId });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      index: 0,
      printedLabel: "U1",
      role: "front_cover",
      sourceAssetId,
      sourcePageIndex: 1,
      width: 1200,
      height: 1600,
      previewKey: "pages/cover.jpg",
      previewUrl: null,
    });
  });
});
