/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { heftSlugBasis } from "./issues";

const modules = import.meta.glob("./**/*.ts");

// ensureFromFolder stoesst den Ladenabgleich an; der soll hier nicht laufen.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup(t: any) {
  return await t.run(async (ctx: any) => {
    const editorId = await ctx.db.insert("users", {
      email: "redaktion@example.de",
      roles: ["editor"],
    });
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: 1,
    });
    return { editorId, publicationId };
  });
}

const ordner = (title: string, issueNumber: string) => ({
  publicationSlug: "zuerst",
  publicationName: "ZUERST!",
  title,
  issueNumber,
});

describe("Doppelhefte in Convex", () => {
  test("Adresse ohne doppelte Nummer", () => {
    expect(heftSlugBasis("ZUERST! 8-9/2025", "8-9/2025")).toBe("zuerst-8-9-2025");
    expect(heftSlugBasis("Greim", "36")).toBe("greim-36");
    expect(heftSlugBasis("ZUERST!", "3/2026")).toBe("zuerst-3-2026");
  });

  test("Anlegen, Wiederfinden in anderer Schreibweise, Jahr mit Tippfehler", async () => {
    const t = convexTest(schema, modules);
    const { editorId } = await setup(t);
    const als = t.withIdentity({ subject: editorId });
    const erst = await als.mutation(api.issues.ensureFromFolder, ordner("ZUERST! 8-9/2025", "8-9/2025"));
    expect(erst.created).toBe(true);
    const heft = await t.run(async (ctx: any) => ctx.db.get(erst.issueId));
    expect(heft).toMatchObject({
      title: "ZUERST! 8-9/2025",
      issueNumber: "8-9/2025",
      slug: "zuerst-8-9-2025",
    });
    // Zweiter Import, Ordner anders geschrieben: dasselbe Heft.
    const zweit = await als.mutation(api.issues.ensureFromFolder, ordner("ZUERST! 08/09 2025", "08/09 2025"));
    expect(zweit).toMatchObject({ issueId: erst.issueId, created: false });
    // Ein Einzelheft 9/2025 ist ein anderes Heft.
    const neun = await als.mutation(api.issues.ensureFromFolder, ordner("ZUERST! 9/2025", "9/2025"));
    expect(neun.issueId).not.toBe(erst.issueId);
    // "6/6026" legt kein Heft an.
    await expect(
      als.mutation(api.issues.ensureFromFolder, ordner("ZUERST! 6/6026", "6/6026")),
    ).rejects.toThrow(/6026/);
  });

  test("Redaktion tippt die Nummer frei, gespeichert wird die feste Form", async () => {
    const t = convexTest(schema, modules);
    const { editorId } = await setup(t);
    const als = t.withIdentity({ subject: editorId });
    const { issueId } = await als.mutation(api.issues.ensureFromFolder, ordner("ZUERST! 8/2025", "8/2025"));
    await als.mutation(api.issues.update, { issueId, issueNumber: "8/9 2025" });
    expect((await t.run(async (ctx: any) => ctx.db.get(issueId))).issueNumber).toBe("8-9/2025");
    await expect(als.mutation(api.issues.update, { issueId, issueNumber: "6/6026" })).rejects.toThrow(/6026/);
  });

  test("berichtigte Adresse, die alte fuehrt weiter", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    // So stand ZUERST! 8-9/2025 im Bestand (28.10.2026).
    const issueId = await t.run(async (ctx: any) =>
      ctx.db.insert("issues", {
        publicationId,
        title: "ZUERST! 8-9/2025",
        slug: "9-2025-8",
        issueNumber: "8-9/2025",
        pageCount: 100,
        priceAmountCents: 795,
        isPublished: true,
        includedInSubscription: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const probe = await t.mutation(internal.issues.slugErneuernInternal, { issueId });
    expect(probe).toEqual({ alt: "9-2025-8", neu: "zuerst-8-9-2025", geaendert: false });
    expect((await t.run(async (ctx: any) => ctx.db.get(issueId))).slug).toBe("9-2025-8");
    await t.mutation(internal.issues.slugErneuernInternal, { issueId, apply: true });
    const heft = await t.run(async (ctx: any) => ctx.db.get(issueId));
    expect(heft).toMatchObject({ slug: "zuerst-8-9-2025", alteSlugs: ["9-2025-8"] });
    expect(await t.query(api.issues.getBySlug, { slug: "zuerst-8-9-2025" })).toBe(issueId);
    expect(await t.query(api.issues.getBySlug, { slug: "9-2025-8" })).toBe(issueId);
    expect(await t.query(api.issues.getBySlug, { slug: "gibt-es-nicht" })).toBeNull();
    // Zweiter Lauf aendert nichts.
    expect(await t.mutation(internal.issues.slugErneuernInternal, { issueId, apply: true })).toMatchObject({
      geaendert: false,
    });
  });

  test("Kiosk ordnet ein Doppelheft ohne Datum nach seinem ersten Monat", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    await t.run(async (ctx: any) => {
      const heft = (nummer: string, createdAt: number, publicationDate?: number) =>
        ctx.db.insert("issues", {
          publicationId,
          title: `ZUERST! ${nummer}`,
          slug: nummer.replace(/\W+/g, "-"),
          issueNumber: nummer,
          publicationDate,
          pageCount: 84,
          priceAmountCents: 795,
          isPublished: true,
          includedInSubscription: true,
          createdAt,
          updatedAt: createdAt,
        });
      await heft("10/2025", 1, Date.UTC(2025, 9, 1));
      // Als letztes importiert, ohne Datum: gehoert trotzdem zwischen 7 und 10.
      await heft("8-9/2025", Date.UTC(2026, 9, 28));
      await heft("7/2025", 2, Date.UTC(2025, 6, 1));
    });
    const liste = await t.query(api.issues.listPublished, {});
    expect(liste.map((i: any) => i.issueNumber)).toEqual(["10/2025", "8-9/2025", "7/2025"]);
    expect(liste[1].edition).toBe("Nr. 8-9/2025");
  });
});
