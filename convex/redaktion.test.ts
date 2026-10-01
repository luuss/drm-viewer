/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function setup(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const editorId = await ctx.db.insert("users", { email: "redaktion@example.de", roles: ["editor"] });
    const publisherId = await ctx.db.insert("users", { email: "verlag@example.de", roles: ["publisher"] });
    const leserId = await ctx.db.insert("users", { email: "leser@example.de" });
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: "Entwurf",
      slug: "entwurf",
      pageCount: 4,
      priceAmountCents: 999,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    return { editorId, publisherId, leserId, issueId };
  });
}

describe("Redaktion", () => {
  test("die Redaktion sieht ein unveroeffentlichtes Heft (Vorschau), Leser nicht", async () => {
    const t = convexTest(schema, modules);
    const { editorId, leserId, issueId } = await setup(t);
    const alsRedaktion = await t.withIdentity({ subject: editorId }).query(api.issues.getPublic, { issueId });
    const alsLeser = await t.withIdentity({ subject: leserId }).query(api.issues.getPublic, { issueId });
    expect(alsRedaktion?.owned).toBe(true);
    expect(alsLeser).toBeNull();
    // In der Bibliothek der Redaktion steht das Heft nicht.
    const bibliothek = await t.withIdentity({ subject: editorId }).query(api.issues.myLibrary, {});
    expect(bibliothek.some((i: any) => i._id === issueId)).toBe(false);
  });

  test("Heftliste und Arbeitsplatz liefern den Stand", async () => {
    const t = convexTest(schema, modules);
    const { editorId, issueId } = await setup(t);
    const als = t.withIdentity({ subject: editorId });
    const liste = await als.query(api.issues.overviewForEditors, {});
    expect(liste).toHaveLength(1);
    expect(liste[0]).toMatchObject({ _id: issueId, pendingArticles: 0, lastJob: null });
    const heft = await als.query(api.issues.getForEditor, { issueId });
    expect(heft).toMatchObject({ title: "Entwurf", tocCount: 0, jobs: [] });
  });

  test("Preis von Hand laesst sich dem Netzladen zurueckgeben", async () => {
    const t = convexTest(schema, modules);
    const { editorId, issueId } = await setup(t);
    const als = t.withIdentity({ subject: editorId });
    await als.mutation(api.issues.update, { issueId, priceAmountCents: 1290 });
    expect((await als.query(api.issues.getForEditor, { issueId }))?.priceSource).toBe("redaktion");
    await als.mutation(api.issues.update, { issueId, priceAuto: true });
    const heft = await als.query(api.issues.getForEditor, { issueId });
    expect(heft?.priceSource).toBeNull();
    expect(heft?.priceAmountCents).toBe(1290);
  });

  test("eine geaenderte Importflaeche gehoert danach der Redaktion", async () => {
    const t = convexTest(schema, modules);
    const { editorId, issueId } = await setup(t);
    const linkId = await t.run(async (ctx: any) =>
      ctx.db.insert("pageLinks", {
        issueId,
        pageIndex: 1,
        x0: 0.1,
        y0: 0.1,
        x1: 0.4,
        y1: 0.3,
        kind: "subscription",
        publicationSlug: "zuerst",
        source: "import",
      }),
    );
    const als = t.withIdentity({ subject: editorId });
    await als.mutation(api.pageLinks.save, {
      issueId,
      linkId,
      link: { pageIndex: 1, x0: 0.5, y0: 0.5, x1: 0.2, y1: 0.2, kind: "url", url: "https://example.de/x" },
    });
    const [row] = await als.query(api.pageLinks.listForEditors, { issueId });
    expect(row).toMatchObject({
      source: "editor",
      kind: "url",
      x0: 0.2,
      x1: 0.5,
      publicationSlug: null,
      target: "https://example.de/x",
    });
    await expect(
      als.mutation(api.pageLinks.save, {
        issueId,
        link: { pageIndex: 1, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3, kind: "url", url: "kein-link" },
      }),
    ).rejects.toThrow(/https/);
  });

  test("nur Freiexemplare lassen sich zuruecknehmen, Kaeufe nicht", async () => {
    const t = convexTest(schema, modules);
    const { publisherId, leserId, issueId } = await setup(t);
    const als = t.withIdentity({ subject: publisherId });
    await als.mutation(api.entitlements.grantByEmail, { issueId, email: "leser@example.de" });
    const kaufId = await t.run(async (ctx: any) =>
      ctx.db.insert("entitlements", { userId: leserId, issueId, source: "purchase", createdAt: Date.now() }),
    );
    const frei = await als.query(api.entitlements.listGrants, { issueId });
    expect(frei.map((g: any) => g.email)).toEqual(["leser@example.de"]);
    await als.mutation(api.entitlements.revokeGrant, { entitlementId: frei[0]._id });
    expect(await als.query(api.entitlements.listGrants, { issueId })).toHaveLength(0);
    await expect(als.mutation(api.entitlements.revokeGrant, { entitlementId: kaufId })).rejects.toThrow();
  });
});
