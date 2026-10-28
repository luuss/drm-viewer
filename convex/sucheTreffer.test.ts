/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

type Artikel = { titel: string; absaetze: string[] };

/**
 * Veroeffentlichte Hefte mit Artikeln und Absaetzen; die Suchstuecke entstehen
 * wie beim Veroeffentlichen. Der Leser hat die Rolle "Alle Hefte".
 */
async function anlegen(t: ReturnType<typeof convexTest>, hefte: { titel: string; datum: number; artikel: Artikel[] }[]) {
  const ids = await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: now,
    });
    const quelle = await ctx.db.insert("assets", {
      key: "quelle",
      contentType: "application/pdf",
      kind: "source",
      createdAt: now,
    });
    const out: Record<string, string> = {};
    for (const [h, heft] of hefte.entries()) {
      const issueId = await ctx.db.insert("issues", {
        publicationId,
        title: heft.titel,
        slug: `heft-${h}`,
        pageCount: 20,
        priceAmountCents: 795,
        publicationDate: heft.datum,
        isPublished: true,
        includedInSubscription: true,
        createdAt: now,
        updatedAt: now,
      });
      for (let index = 0; index < 20; index++) {
        await ctx.db.insert("issuePages", {
          issueId,
          index,
          printedLabel: index === 0 ? "U1" : String(index + 2),
          role: index === 0 ? "front_cover" : "content",
          sourceAssetId: quelle,
          sourcePageIndex: index,
          width: 100,
          height: 140,
        });
      }
      for (const [a, artikel] of heft.artikel.entries()) {
        const articleId = await ctx.db.insert("articles", {
          issueId,
          order: a + 1,
          title: artikel.titel,
          source: "idml",
          reviewStatus: "approved",
          primaryPageIndex: 4 + a,
          pageStart: 4 + a,
          pageEnd: 4 + a,
          searchText: [artikel.titel, ...artikel.absaetze].join("\n\n"),
          createdAt: now,
          updatedAt: now,
        });
        out[`${heft.titel}/${artikel.titel}`] = articleId;
        await ctx.db.insert("articleBlocks", {
          articleId,
          issueId,
          order: 1,
          type: "heading",
          text: artikel.titel,
          sourcePageIndex: 4 + a,
        });
        for (const [b, text] of artikel.absaetze.entries()) {
          await ctx.db.insert("articleBlocks", {
            articleId,
            issueId,
            order: b + 2,
            type: "paragraph",
            text,
            sourcePageIndex: 4 + a + (b >= 2 ? 1 : 0),
          });
        }
      }
    }
    out.leser = await ctx.db.insert("users", { email: "leser@example.de", roles: ["reader"] });
    // Feldnamen in Convex-Werten sind nur ASCII; die Titel tragen Umlaute.
    return Object.entries(out);
  }).then((paare: [string, string][]) => Object.fromEntries(paare));
  vi.useFakeTimers();
  await t.mutation(internal.suche.allesNeu, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  return ids;
}

describe("Suche in den eigenen Heften", () => {
  test("ganze Woerter vor Wortanfaengen, im selben Rang das neuere Heft zuerst", async () => {
    const t = convexTest(schema, modules);
    const ids = await anlegen(t, [
      {
        titel: "ZUERST! 1/2025",
        datum: Date.UTC(2025, 0, 1),
        artikel: [
          { titel: "Brüssel plant", absaetze: ["Die Europäische Union und Europa wachsen."] },
          { titel: "Alte Währung", absaetze: ["Der Euro war einmal stark."] },
        ],
      },
      {
        titel: "ZUERST! 3/2026",
        datum: Date.UTC(2026, 2, 1),
        artikel: [
          { titel: "Neue Schulden", absaetze: ["Vorweg.", "Der Euro verliert an Wert."] },
          { titel: "Der Euro wankt", absaetze: ["Ein Absatz ohne den Begriff."] },
        ],
      },
    ]);
    const leser = t.withIdentity({ subject: `${ids.leser}|s` });
    const r = await leser.query(api.articles.search, { term: "Euro" });
    expect(r.treffer.map((x: any) => x.title)).toEqual([
      "Der Euro wankt", // ganzes Wort im Titel
      "Neue Schulden", // ganzes Wort im Text, neueres Heft
      "Alte Währung", // ganzes Wort im Text, aelteres Heft
      "Brüssel plant", // nur "Europa"
    ]);
    expect(r.gesamt).toBe(4);
    expect(r.vollstaendig).toBe(true);
  });

  test("jeder Treffer nennt den Absatz der Fundstelle und die gedruckte Seite", async () => {
    const t = convexTest(schema, modules);
    const ids = await anlegen(t, [
      {
        titel: "ZUERST! 4/2025",
        datum: Date.UTC(2025, 3, 1),
        artikel: [
          {
            titel: "Kampfzone Indopazifik",
            absaetze: ["Erster Absatz.", "Zweiter Absatz.", "Die Flugzeugträger der Amerikaner kreuzen."],
          },
        ],
      },
    ]);
    const leser = t.withIdentity({ subject: `${ids.leser}|s` });
    const r = await leser.query(api.articles.search, { term: "Flugzeugträger" });
    expect(r.treffer).toHaveLength(1);
    expect(r.treffer[0]).toMatchObject({
      _id: ids["ZUERST! 4/2025/Kampfzone Indopazifik"],
      stelle: 4,
      pageIndex: 5,
      page: "7",
    });
    expect(r.treffer[0].snippet).toContain("Flugzeugträger");
    // Nur im Titel: keine Fundstelle im Text, der Artikel oeffnet am Anfang.
    const titel = await leser.query(api.articles.search, { term: "Indopazifik" });
    expect(titel.treffer[0].stelle).toBeNull();
  });

  test("bricht nicht still ab: weitere Treffer auf Wunsch, die Zahl stimmt", async () => {
    const t = convexTest(schema, modules);
    const artikel = Array.from({ length: 30 }, (_, i) => ({
      titel: `Meldung ${i + 1}`,
      absaetze: [`Bericht über Grönland, Teil ${i + 1}.`],
    }));
    const ids = await anlegen(t, [{ titel: "ZUERST! 5/2025", datum: Date.UTC(2025, 4, 1), artikel }]);
    const leser = t.withIdentity({ subject: `${ids.leser}|s` });
    const erste = await leser.query(api.articles.search, { term: "Grönland" });
    expect(erste.treffer).toHaveLength(25);
    expect(erste.gesamt).toBe(30);
    const alle = await leser.query(api.articles.search, { term: "Grönland", limit: 50 });
    expect(alle.treffer).toHaveLength(30);
    // Die ersten 25 behalten ihre Reihenfolge.
    expect(alle.treffer.slice(0, 25).map((x: any) => x._id)).toEqual(
      erste.treffer.map((x: any) => x._id),
    );
  });

  test("ohne Anmeldung keine Textstellen", async () => {
    const t = convexTest(schema, modules);
    await anlegen(t, [
      { titel: "ZUERST! 6/2025", datum: Date.UTC(2025, 5, 1), artikel: [{ titel: "X", absaetze: ["Grönland"] }] },
    ]);
    const r = await t.query(api.articles.search, { term: "Grönland" });
    expect(r).toEqual({ treffer: [], gesamt: 0, vollstaendig: true });
  });
});
