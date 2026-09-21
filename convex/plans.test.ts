import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  SUBSCRIPTION_CATALOG,
  catalogVariants,
  missingVariants,
} from "./subscriptionCatalog";

const modules = import.meta.glob("./**/*.ts");

/** Beide Verlagstitel mit allen Preisstufen aus dem Katalog, dazu ein Titel ohne Abo. */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const archiv = await ctx.db.insert("publications", {
      name: "Archiv", slug: "archiv", isActive: true, createdAt: 1,
    });
    const zuerst = await ctx.db.insert("publications", {
      name: "ZUERST!", slug: "zuerst", isActive: true, createdAt: 2,
    });
    const dmz = await ctx.db.insert("publications", {
      name: "Deutsche Militärzeitschrift", slug: "dmz", isActive: true, createdAt: 3,
    });
    for (const [slug, publicationId] of [["zuerst", zuerst], ["dmz", dmz]] as const) {
      // Absichtlich in umgekehrter Reihenfolge eingefuegt: die Anzeige muss
      // sich nach sortOrder richten, nicht nach dem Zufall des Anlegens.
      for (const variant of catalogVariants(SUBSCRIPTION_CATALOG[slug]).reverse()) {
        await ctx.db.insert("subscriptionPlans", {
          name: variant.name,
          description: variant.tierNote,
          publicationId,
          stripePriceId: `price_${slug}_${variant.sortOrder}`,
          priceAmountCents: variant.priceAmountCents,
          interval: "year",
          tier: variant.tier,
          tierNote: variant.tierNote,
          region: variant.region,
          isActive: true,
          sortOrder: variant.sortOrder,
          createdAt: 1,
        });
      }
    }
    return { archiv, zuerst, dmz };
  });
}

describe("Abos im Kiosk", () => {
  test("je Titel ein Abo mit dem Inlandspreis des Normalabonnements", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const offers = await t.query(api.plans.offers, {});
    expect(offers.map((o) => o.publicationSlug)).toEqual(["zuerst", "dmz"]);
    expect(offers[0].headline).toMatchObject({
      tier: "Normalabonnement",
      region: "inland",
      priceAmountCents: 10440,
      interval: "year",
    });
    expect(offers[1].headline).toMatchObject({
      tier: "Normalabonnement",
      region: "inland",
      priceAmountCents: 5880,
    });
  });

  test("die Abo-Seite gruppiert die Stufen nach Abo-Art in Katalogreihenfolge", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const offer = await t.query(api.plans.offerBySlug, { slug: "zuerst" });
    expect(offer).not.toBeNull();
    expect(offer!.tiers.map((tier) => tier.tier)).toEqual([
      "Normalabonnement",
      "Schüler- und Studentenabonnement",
      "Kombi-Abonnement",
      "Förderabonnement",
    ]);
    expect(offer!.tiers[0].note).toBeNull();
    expect(offer!.tiers[1].note).toBe(
      "Kopie des Schüler- oder Studentenausweises erforderlich",
    );
    // Das Kombi-Abo gibt es nicht per Luftpost.
    expect(offer!.tiers[2].plans.map((p) => p.region)).toEqual(["inland", "ausland"]);
    expect(offer!.tiers[3].plans.map((p) => [p.region, p.priceAmountCents])).toEqual([
      ["inland", 12600],
      ["ausland", 15300],
      ["luftpost", 17700],
    ]);
    expect(offer!.headline._id).toBe(offer!.tiers[0].plans[0]._id);
  });

  test("abgeschaltete Stufen und Titel ohne Abo erscheinen nicht", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      const luftpost = (await ctx.db.query("subscriptionPlans").collect()).find(
        (p) => p.tier === "Förderabonnement" && p.region === "luftpost",
      );
      await ctx.db.patch(luftpost!._id, { isActive: false });
    });
    const offer = await t.query(api.plans.offerBySlug, { slug: "zuerst" });
    expect(offer!.tiers[3].plans.map((p) => p.region)).toEqual(["inland", "ausland"]);
    expect(await t.query(api.plans.offerBySlug, { slug: "archiv" })).toBeNull();
    expect(await t.query(api.plans.offerBySlug, { slug: "gibt-es-nicht" })).toBeNull();
    const offers = await t.query(api.plans.offers, {});
    expect(offers.map((o) => o.publicationSlug)).toEqual(["zuerst", "dmz"]);
  });

  test("der Umschlag des juengsten veroeffentlichten Hefts steht fuer das Abo", async () => {
    const t = convexTest(schema, modules);
    const { zuerst } = await seed(t);
    await t.run(async (ctx) => {
      const base = {
        publicationId: zuerst,
        pageCount: 84,
        priceAmountCents: 999,
        includedInSubscription: true,
        createdAt: 1,
        updatedAt: 1,
      };
      await ctx.db.insert("issues", {
        ...base, title: "ZUERST! 2/2026", slug: "zuerst-2-2026",
        isPublished: true, publicationDate: 200,
      });
      await ctx.db.insert("issues", {
        ...base, title: "ZUERST! 3/2026", slug: "zuerst-3-2026",
        isPublished: true, publicationDate: 300,
      });
      await ctx.db.insert("issues", {
        ...base, title: "ZUERST! 4/2026", slug: "zuerst-4-2026",
        isPublished: false, publicationDate: 400,
      });
    });
    const offer = await t.query(api.plans.offerBySlug, { slug: "zuerst" });
    expect(offer!.latestIssueTitle).toBe("ZUERST! 3/2026");
  });
});

describe("Abo-Katalog", () => {
  test("die Stufen folgen der Reihenfolge Abo-Art, dann Liefergebiet", () => {
    const dmz = catalogVariants(SUBSCRIPTION_CATALOG.dmz);
    expect(dmz.map((v) => v.name)).toEqual([
      "Normalabonnement Inland",
      "Normalabonnement Ausland",
      "Schüler- und Studentenabonnement Inland",
      "Schüler- und Studentenabonnement Ausland",
      "Förderabonnement Inland",
      "Förderabonnement Ausland",
    ]);
    expect(dmz.map((v) => v.sortOrder)).toEqual([0, 1, 10, 11, 20, 21]);
  });

  test("ein wiederholter Lauf legt vorhandene Stufen nicht noch einmal an", () => {
    const missing = missingVariants(SUBSCRIPTION_CATALOG.zuerst, [
      { tier: "Normalabonnement", region: "inland" },
      { tier: "Kombi-Abonnement", region: "ausland" },
      // Ein Plan ohne Abo-Art (etwa aus der Verwaltung) blockiert nichts.
      { tier: undefined, region: undefined },
    ]);
    expect(missing).toHaveLength(9);
    expect(missing.map((v) => v.name)).not.toContain("Normalabonnement Inland");
    expect(missing.map((v) => v.name)).not.toContain("Kombi-Abonnement Ausland");
  });
});
