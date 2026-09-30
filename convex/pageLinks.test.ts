import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { defaultSubscriptionUrl } from "./pageLinks";

const modules = import.meta.glob("./**/*.ts");

async function heft(t: any) {
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
      pageCount: 4,
      priceAmountCents: 870,
      isPublished: true,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("pageLinks", {
      issueId,
      pageIndex: 1,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
      kind: "subscription",
      publicationSlug: "dmz",
      source: "import",
    });
    await ctx.db.insert("pageLinks", {
      issueId,
      pageIndex: 5,
      x0: 0.1,
      y0: 0.1,
      x1: 0.4,
      y1: 0.3,
      kind: "url",
      url: "https://lesenundschenken.de/aktion",
      source: "editor",
    });
    return { issueId };
  });
}

describe("Seitenlinks", () => {
  test("der Import ersetzt nur seine eigenen Flaechen", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const result = await t.mutation(internal.pageLinks.replaceImportedInternal, {
      issueId,
      links: [
        {
          pageIndex: 82,
          x0: 0,
          y0: 0,
          x1: 1,
          y1: 1,
          kind: "subscription",
          publicationSlug: "zuerst",
          label: "Abonnement",
        },
      ],
    });
    expect(result).toEqual({ links: 1 });
    const rows = await t.run(async (ctx: any) =>
      await ctx.db
        .query("pageLinks")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect(),
    );
    expect(rows.map((r: any) => [r.pageIndex, r.source])).toEqual([
      [5, "editor"],
      [82, "import"],
    ]);
  });

  test("das Abo-Formular folgt der Kennung der Reihe", () => {
    expect(defaultSubscriptionUrl("dmz-zeitgeschichte")).toBe(
      "https://lesenundschenken.de/module/luszeitformulare/formular?f=abo-dmz-zeitgeschichte",
    );
  });
});
