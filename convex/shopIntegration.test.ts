import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { addMonths } from "./shopIntegration";

const modules = import.meta.glob("./**/*.ts");

const DAY = 24 * 60 * 60 * 1000;
const SECRET = "test-geheimnis";

async function setup(t: any) {
  return await t.run(async (ctx: any) => {
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      shopSubscriptionSku: "ZUERST-DIGITAL-ABO",
      createdAt: Date.now(),
    });
    const otherPublicationId = await ctx.db.insert("publications", {
      name: "DMZ",
      slug: "dmz",
      isActive: true,
      createdAt: Date.now(),
    });
    return { publicationId, otherPublicationId };
  });
}

async function addIssue(
  t: any,
  publicationId: Id<"publications">,
  opts: { sku?: string; published?: boolean; inSubscription?: boolean; publishedAt?: number } = {},
) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    return await ctx.db.insert("issues", {
      publicationId,
      title: `Heft ${Math.random().toString(36).slice(2, 6)}`,
      slug: `heft-${Math.random().toString(36).slice(2)}`,
      pageCount: 4,
      priceAmountCents: 999,
      isPublished: opts.published ?? true,
      includedInSubscription: opts.inSubscription ?? true,
      publishedAt: opts.publishedAt ?? now,
      externalSku: opts.sku,
      createdAt: opts.publishedAt ?? now,
      updatedAt: now,
    });
  });
}

async function addUser(t: any, email: string) {
  return await t.run(async (ctx: any) => await ctx.db.insert("users", { email }));
}

async function access(t: any, userId: Id<"users">, issueId: Id<"issues">) {
  return await t.run(async (ctx: any) => {
    const { hasIssueAccess } = await import("./access");
    return await hasIssueAccess(ctx, userId, issueId);
  });
}

async function library(t: any, userId: Id<"users">) {
  return await t.run(async (ctx: any) => {
    const { accessibleIssueIds } = await import("./access");
    return Array.from(await accessibleIssueIds(ctx, userId));
  });
}

function order(
  externalOrderId: string,
  action: "grant" | "revoke",
  items: { sku: string; lineId: string }[],
  email = "kunde@example.de",
) {
  return { externalOrderId, email, action, items };
}

describe("Shop-Schnittstelle v2", () => {
  test("schaltet alle Hefte einer Bestellung frei und ueberspringt Druckware", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const a = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const b = await addIssue(t, publicationId, { sku: "ZUERST-4-2026" });
    const userId = await addUser(t, "kunde@example.de");

    const res = await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("A-1", "grant", [
        { sku: "ZUERST-3-2026", lineId: "11" },
        { sku: "BUCH-4711", lineId: "12" },
        { sku: "ZUERST-4-2026", lineId: "13" },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.results.map((r: any) => r.kind)).toEqual(["issue", "unknown", "issue"]);
    expect(res.results.every((r: any) => r.ok)).toBe(true);
    expect(await access(t, userId, a)).toBe(true);
    expect(await access(t, userId, b)).toBe(true);
  });

  test("ist idempotent je Position und Aktion", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const body = order("A-2", "grant", [{ sku: "ZUERST-3-2026", lineId: "1" }]);
    await t.mutation(internal.shopIntegration.applyOrderInternal, body);
    const again = await t.mutation(internal.shopIntegration.applyOrderInternal, body);
    expect(again.results[0].message).toMatch(/^wiederholt/);
    const rows = await t.run(async (ctx: any) => await ctx.db.query("shopAccess").collect());
    expect(rows.length).toBe(1);
  });

  test("unbekannte Position wirkt, sobald die Redaktion die Artikelnummer eintraegt", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const userId = await addUser(t, "kunde@example.de");
    const body = order("A-3", "grant", [{ sku: "SPAETER", lineId: "1" }]);
    const first = await t.mutation(internal.shopIntegration.applyOrderInternal, body);
    expect(first.results[0].kind).toBe("unknown");
    const issueId = await addIssue(t, publicationId, { sku: "SPAETER" });
    const second = await t.mutation(internal.shopIntegration.applyOrderInternal, body);
    expect(second.results[0].kind).toBe("issue");
    expect(await access(t, userId, issueId)).toBe(true);
  });

  test("Kauf vor Kontoanlage greift nach der Registrierung, Adresse normalisiert", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const res = await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("A-4", "grant", [{ sku: "ZUERST-3-2026", lineId: "1" }], "  Kunde@Example.DE "),
    );
    expect(res.results[0].ok).toBe(true);
    // Das Konto entsteht erst danach; auth.ts legt Adressen klein ab.
    const userId = await addUser(t, "kunde@example.de");
    expect(await access(t, userId, issueId)).toBe(true);
    expect(await library(t, userId)).toContain(issueId);
    const stranger = await addUser(t, "andere@example.de");
    expect(await access(t, stranger, issueId)).toBe(false);
  });

  test("Widerruf nimmt genau die Position zurueck", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const other = await addIssue(t, publicationId, { sku: "ZUERST-4-2026" });
    const userId = await addUser(t, "kunde@example.de");
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("A-5", "grant", [
        { sku: "ZUERST-3-2026", lineId: "1" },
        { sku: "ZUERST-4-2026", lineId: "2" },
      ]),
    );
    // Dasselbe Heft noch einmal in einer zweiten Bestellung.
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("B-5", "grant", [{ sku: "ZUERST-3-2026", lineId: "1" }]),
    );
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("A-5", "revoke", [{ sku: "ZUERST-3-2026", lineId: "1" }]),
    );
    expect(await access(t, userId, issueId)).toBe(true);
    expect(await access(t, userId, other)).toBe(true);
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("B-5", "revoke", [{ sku: "ZUERST-3-2026", lineId: "1" }]),
    );
    expect(await access(t, userId, issueId)).toBe(false);
    expect(await access(t, userId, other)).toBe(true);
  });

  test("altes Einzelformat bleibt gueltig", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const userId = await addUser(t, "kunde@example.de");
    const res = await t.mutation(internal.shopIntegration.applyInternal, {
      externalOrderId: "ALT-1",
      email: "kunde@example.de",
      issueSku: "ZUERST-3-2026",
      action: "grant",
    });
    expect(res.results[0].kind).toBe("issue");
    expect(await access(t, userId, issueId)).toBe(true);
    // Mit issueId statt Artikelnummer, auch mit ungueltiger Kennung ohne Absturz.
    const byId = await t.mutation(internal.shopIntegration.applyInternal, {
      externalOrderId: "ALT-2",
      email: "kunde@example.de",
      issueId: "keine-kennung",
      action: "grant",
    });
    expect(byId.results[0].kind).toBe("unknown");
  });
});

describe("Digital-Abo aus dem Laden", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("schaltet alle Abo-Ausgaben der Reihe bis zum Ablauf frei", async () => {
    const t = convexTest(schema, modules);
    const { publicationId, otherPublicationId } = await setup(t);
    const old = await addIssue(t, publicationId, { publishedAt: Date.now() - 400 * DAY });
    const draft = await addIssue(t, publicationId, { published: false });
    const special = await addIssue(t, publicationId, { inSubscription: false });
    const foreign = await addIssue(t, otherPublicationId);
    const userId = await addUser(t, "kunde@example.de");

    const res = await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-1", "grant", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "1" }]),
    );
    expect(res.results[0].kind).toBe("subscription");
    expect(res.results[0].message).toBe("Digital-Abo bis 01.10.2027");

    expect(await access(t, userId, old)).toBe(true);
    expect(await access(t, userId, draft)).toBe(false);
    expect(await access(t, userId, special)).toBe(false);
    expect(await access(t, userId, foreign)).toBe(false);

    // Spaeter erschienene Hefte gehoeren ohne weiteren Abgleich dazu.
    vi.setSystemTime(new Date("2027-03-01T12:00:00Z"));
    const fresh = await addIssue(t, publicationId);
    expect(await access(t, userId, fresh)).toBe(true);
    expect(await library(t, userId)).toEqual(expect.arrayContaining([old, fresh]));

    vi.setSystemTime(new Date("2027-10-01T12:00:01Z"));
    expect(await access(t, userId, fresh)).toBe(false);
    expect(await library(t, userId)).toEqual([]);
  });

  test("Laufzeit aus der Reihe, Verlaengerung ab bisherigem Ende, Widerruf rueckt nach", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    await t.run(async (ctx: any) => {
      await ctx.db.patch(publicationId, { shopSubscriptionMonths: 6 });
    });
    const issueId = await addIssue(t, publicationId);
    const userId = await addUser(t, "kunde@example.de");
    const start = Date.now();

    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-2", "grant", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "1" }]),
    );
    vi.setSystemTime(start + 30 * DAY);
    const second = await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-3", "grant", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "7" }]),
    );
    // Verlaengert ab dem bisherigen Ende, nicht ab heute.
    expect(second.results[0].message).toBe("Digital-Abo bis 01.10.2027");

    const until = async () =>
      await t.run(async (ctx: any) => {
        const rows = await ctx.db.query("shopAccess").collect();
        return Math.max(
          ...rows.filter((r: any) => r.revokedAt === undefined).map((r: any) => r.validUntil),
        );
      });
    expect(await until()).toBe(addMonths(addMonths(start, 6), 6));

    // Storno der ersten Bestellung: die zweite laeuft ab ihrem Kaufzeitpunkt.
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-2", "revoke", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "1" }]),
    );
    expect(await until()).toBe(addMonths(start + 30 * DAY, 6));
    expect(await access(t, userId, issueId)).toBe(true);

    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-3", "revoke", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "7" }]),
    );
    expect(await access(t, userId, issueId)).toBe(false);
  });

  test("abgelaufenes Abo wird ab jetzt neu begonnen", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-4", "grant", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "1" }]),
    );
    vi.setSystemTime(new Date("2029-01-15T12:00:00Z"));
    const res = await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("S-5", "grant", [{ sku: "ZUERST-DIGITAL-ABO", lineId: "1" }]),
    );
    expect(res.results[0].message).toBe("Digital-Abo bis 15.01.2030");
    void publicationId;
  });
});

describe("Lesesitzung und Kachel-Gateway", () => {
  test("ein Widerruf beendet auch die laufende Sitzung", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const userId = await addUser(t, "kunde@example.de");
    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("R-1", "grant", [{ sku: "ZUERST-3-2026", lineId: "1" }]),
    );
    const asReader = t.withIdentity({ subject: userId, email: "kunde@example.de" });
    const { token } = await asReader.mutation(api.readerSessions.issue, { issueId });
    const ok = await t.query(internal.readerSessions.verifyInternal, { sessionToken: token });
    expect(ok.ok).toBe(true);

    await t.mutation(
      internal.shopIntegration.applyOrderInternal,
      order("R-1", "revoke", [{ sku: "ZUERST-3-2026", lineId: "1" }]),
    );
    const gone = await t.query(internal.readerSessions.verifyInternal, { sessionToken: token });
    expect(gone).toEqual({ ok: false, reason: "no_access" });
  });
});

describe("HTTP-Endpunkt /shop/entitlements", () => {
  beforeEach(() => {
    vi.stubEnv("SHOP_WEBHOOK_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function sign(body: string, secret = SECRET) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    return Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function post(t: any, payload: unknown, secret = SECRET) {
    const body = JSON.stringify(payload);
    return await t.fetch("/shop/entitlements", {
      method: "POST",
      headers: { "content-type": "application/json", "x-shop-signature": await sign(body, secret) },
      body,
    });
  }

  test("v2-Rumpf mit Zahlen als Kennung ergibt 200 und Ergebnis je Position", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const res = await post(t, {
      externalOrderId: 1234,
      externalCustomerId: 77,
      email: "kunde@example.de",
      action: "grant",
      items: [
        { sku: "ZUERST-3-2026", lineId: 5001 },
        { sku: "ZUERST-DIGITAL-ABO", lineId: "5002" },
        { sku: "T-SHIRT", lineId: "5003" },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.results.map((r: any) => [r.lineId, r.kind, r.ok])).toEqual([
      ["5001", "issue", true],
      ["5002", "subscription", true],
      ["5003", "unknown", true],
    ]);
  });

  test("altes Einzelformat ueber HTTP", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const res = await post(t, {
      externalOrderId: "ALT-9",
      email: "kunde@example.de",
      issueSku: "ZUERST-3-2026",
      action: "grant",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].kind).toBe("issue");
  });

  test("falsche Signatur 403, kaputter Rumpf 400", async () => {
    const t = convexTest(schema, modules);
    await setup(t);
    const bad = await post(
      t,
      { externalOrderId: "X", email: "k@example.de", action: "grant", items: [] },
      "falsch",
    );
    expect(bad.status).toBe(403);
    const noLine = await post(t, {
      externalOrderId: "X",
      email: "k@example.de",
      action: "grant",
      items: [{ sku: "A" }],
    });
    expect(noLine.status).toBe(400);
    const badAction = await post(t, {
      externalOrderId: "X",
      email: "k@example.de",
      action: "refund",
      items: [],
    });
    expect(badAction.status).toBe(400);
  });
});

describe("Artikelnummern in der Redaktion", () => {
  test("dieselbe Nummer nicht zugleich fuer Heft und Digital-Abo", async () => {
    const t = convexTest(schema, modules);
    const { publicationId, otherPublicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });
    const check = (sku: string, own: any) =>
      t.run(async (ctx: any) => {
        const { assertSkuFree } = await import("./shopIntegration");
        await assertSkuFree(ctx, sku, own);
        return true;
      });
    await expect(check("ZUERST-3-2026", { issueId })).resolves.toBe(true);
    await expect(check("ZUERST-3-2026", { publicationId: otherPublicationId })).rejects.toThrow(
      /gehört schon/,
    );
    await expect(check("ZUERST-DIGITAL-ABO", { issueId })).rejects.toThrow(/Digital-Abo/);
  });
});
