import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

// Originalband 327: der Archiv-Import las nur zwei der drei Titelzeilen.
const FALSCH = "Stäbler“ Sander";
const RICHTIG = "„Generalstäbler“ Sander";

async function heft(t: any) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "Weltkrieg Originalband",
      slug: "weltkrieg-originalband",
      isActive: true,
      createdAt: now,
    });
    const issueId = await ctx.db.insert("issues", {
      publicationId,
      title: FALSCH,
      issueNumber: "327",
      slug: "staebler-sander-327",
      pageCount: 68,
      priceAmountCents: 299,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    const articleId = await ctx.db.insert("articles", {
      issueId,
      order: 1,
      title: FALSCH,
      source: "pdf",
      reviewStatus: "approved",
      primaryPageIndex: 2,
      pageStart: 2,
      pageEnd: 65,
      searchText: `${FALSCH}\n\nMai 1941: Deutsche Fallschirmjäger landen auf Kreta`,
      createdAt: now,
      updatedAt: now,
    });
    return { issueId, articleId };
  });
}

describe("titelBerichtigenInternal", () => {
  test("Probelauf zaehlt nur", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const r = await t.mutation(internal.devtools.titelBerichtigenInternal, {
      eintraege: [{ issueId, alt: FALSCH, titel: RICHTIG }],
      probelauf: true,
    });
    expect(r).toMatchObject({ geaendert: 1, artikel: 1, abweichend: [] });
    expect(r.adressen).toEqual([{ alt: "staebler-sander-327", neu: "generalstaebler-sander-327" }]);
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.title).toBe(FALSCH);
  });

  test("berichtigt Titel, Text und Adresse; die alte Adresse fuehrt weiter", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId } = await heft(t);
    await t.mutation(internal.devtools.titelBerichtigenInternal, {
      eintraege: [{ issueId, alt: FALSCH, titel: RICHTIG }],
    });
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.title).toBe(RICHTIG);
    expect(issue.slug).toBe("generalstaebler-sander-327");
    expect(issue.alteSlugs).toEqual(["staebler-sander-327"]);
    const artikel = await t.run((ctx: any) => ctx.db.get(articleId));
    expect(artikel.title).toBe(RICHTIG);
    expect(artikel.searchText.startsWith(`${RICHTIG}\n\nMai 1941`)).toBe(true);
    const log = await t.run((ctx: any) => ctx.db.query("auditLog").collect());
    expect(log.some((l: any) => l.action === "issue.titel")).toBe(true);
  });

  test("laesst ein Heft stehen, dessen Titel die Redaktion schon geaendert hat", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId } = await heft(t);
    await t.run((ctx: any) => ctx.db.patch(issueId, { title: "Von Hand berichtigt" }));
    const r = await t.mutation(internal.devtools.titelBerichtigenInternal, {
      eintraege: [{ issueId, alt: FALSCH, titel: RICHTIG }],
    });
    expect(r.geaendert).toBe(0);
    expect(r.abweichend).toHaveLength(1);
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.title).toBe("Von Hand berichtigt");
    const artikel = await t.run((ctx: any) => ctx.db.get(articleId));
    expect(artikel.title).toBe(FALSCH);
  });
});

describe("Vermerk Titel pruefen (05.11.2026)", () => {
  const VERMERK = {
    umschlag: "Sanitäter Franz Schmitz",
    kolumne: "Oberfeldwebel Franz Schmitz",
    grund: "Titelseite und Kolumnentitel weichen ab",
  };

  async function mitRedaktion(t: any) {
    const { issueId, articleId } = await heft(t);
    const editorId = await t.run((ctx: any) =>
      ctx.db.insert("users", { email: "redaktion@example.de", roles: ["editor"] }),
    );
    return { issueId, articleId, als: t.withIdentity({ subject: editorId }) };
  }

  test("der Import setzt den Vermerk, die Redaktion sieht ihn", async () => {
    const t = convexTest(schema, modules);
    const { issueId, als } = await mitRedaktion(t);
    await als.mutation(api.issues.titelPruefenSetzen, { issueId, pruefen: VERMERK });
    const heftJetzt = await als.query(api.issues.getForEditor, { issueId });
    expect(heftJetzt.titelPruefen).toEqual(VERMERK);
    const liste = await als.query(api.issues.overviewForEditors, {});
    expect(liste.find((i: any) => i._id === issueId)?.titelPruefen).toBe(true);
  });

  test("ein Leser darf keinen Vermerk setzen", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const leserId = await t.run((ctx: any) => ctx.db.insert("users", { email: "leser@example.de" }));
    await expect(
      t.withIdentity({ subject: leserId }).mutation(api.issues.titelPruefenSetzen, { issueId, pruefen: VERMERK }),
    ).rejects.toThrow();
  });

  test("uebernimmt die Redaktion einen Titel, folgt der Text und der Vermerk entfaellt", async () => {
    const t = convexTest(schema, modules);
    const { issueId, articleId, als } = await mitRedaktion(t);
    await als.mutation(api.issues.titelPruefenSetzen, { issueId, pruefen: VERMERK });
    await als.mutation(api.issues.update, { issueId, title: RICHTIG });
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.title).toBe(RICHTIG);
    expect(issue.titelPruefen).toBeUndefined();
    const artikel = await t.run((ctx: any) => ctx.db.get(articleId));
    expect(artikel.title).toBe(RICHTIG);
  });

  test("'stimmt so' hebt den Vermerk auf, ohne den Titel zu aendern", async () => {
    const t = convexTest(schema, modules);
    const { issueId, als } = await mitRedaktion(t);
    await als.mutation(api.issues.titelPruefenSetzen, { issueId, pruefen: VERMERK });
    await als.mutation(api.issues.update, { issueId, titelGeprueft: true });
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.title).toBe(FALSCH);
    expect(issue.titelPruefen).toBeUndefined();
  });

  test("eine andere Angabe laesst den Vermerk stehen", async () => {
    const t = convexTest(schema, modules);
    const { issueId, als } = await mitRedaktion(t);
    await als.mutation(api.issues.titelPruefenSetzen, { issueId, pruefen: VERMERK });
    await als.mutation(api.issues.update, { issueId, title: FALSCH, description: "Mai 1941" });
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.titelPruefen).toEqual(VERMERK);
  });

  test("von der Kommandozeile: setzen und aufheben", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const r = await t.mutation(internal.devtools.titelPruefenInternal, { eintraege: [{ issueId, pruefen: VERMERK }] });
    expect(r).toEqual({ gesetzt: 1, aufgehoben: 0, fehlt: 0 });
    const r2 = await t.mutation(internal.devtools.titelPruefenInternal, { eintraege: [{ issueId, pruefen: null }] });
    expect(r2).toEqual({ gesetzt: 0, aufgehoben: 1, fehlt: 0 });
    const issue = await t.run((ctx: any) => ctx.db.get(issueId));
    expect(issue.titelPruefen).toBeUndefined();
  });
});
