import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const DAY = 24 * 60 * 60 * 1000;

async function setup(t: any) {
  return await t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", { email: "leser@example.de" });
    const publicationId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: Date.now(),
    });
    return { userId, publicationId };
  });
}

async function addIssue(
  t: any,
  publicationId: Id<"publications">,
  opts: { published?: boolean; publishedAt?: number; inSubscription?: boolean; sku?: string } = {},
) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    return await ctx.db.insert("issues", {
      publicationId,
      title: `Heft ${opts.publishedAt ?? now}`,
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

describe("Zugriff auf Ausgaben", () => {
  test("Einzelkauf schaltet dauerhaft frei", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId);
    await t.mutation(internal.entitlements.grantInternal, {
      userId,
      issueId,
      source: "purchase",
    });
    const has = await t.run(async (ctx: any) => {
      const { hasIssueAccess } = await import("./access");
      return await hasIssueAccess(ctx, userId, issueId);
    });
    expect(has).toBe(true);
  });

  test("abgelaufenes Entitlement schliesst aus", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId);
    await t.run(async (ctx: any) => {
      await ctx.db.insert("entitlements", {
        userId,
        issueId,
        source: "gift",
        validUntil: Date.now() - 1000,
        createdAt: Date.now(),
      });
    });
    const has = await t.run(async (ctx: any) => {
      const { hasIssueAccess } = await import("./access");
      return await hasIssueAccess(ctx, userId, issueId);
    });
    expect(has).toBe(false);
  });

  test("ohne Kauf und ohne Abo kein Zugriff", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId);
    const has = await t.run(async (ctx: any) => {
      const { hasIssueAccess } = await import("./access");
      return await hasIssueAccess(ctx, userId, issueId);
    });
    expect(has).toBe(false);
  });
});

describe("Abo schaltet Ausgaben dauerhaft frei", () => {
  async function subscribe(
    t: any,
    userId: Id<"users">,
    publicationId: Id<"publications">,
    opts: { startedAt: number; status?: string; currentPeriodEnd?: number; endedAt?: number },
  ) {
    return await t.run(async (ctx: any) => {
      const subId = await ctx.db.insert("subscriptions", {
        userId,
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: `sub_${Math.random().toString(36).slice(2)}`,
        publicationId,
        status: opts.status ?? "active",
        startedAt: opts.startedAt,
        currentPeriodEnd: opts.currentPeriodEnd,
        endedAt: opts.endedAt,
        updatedAt: Date.now(),
      });
      const { syncSubscription } = await import("./subscriptions");
      await syncSubscription(ctx, subId);
      return subId;
    });
  }

  async function accessible(t: any, userId: Id<"users">) {
    return await t.run(async (ctx: any) => {
      const { accessibleIssueIds } = await import("./access");
      return Array.from(await accessibleIssueIds(ctx, userId));
    });
  }

  test("aktuelles Heft bei Abschluss zaehlt dazu, auch wenn es aelter ist", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const older = await addIssue(t, publicationId, { publishedAt: Date.now() - 60 * DAY });
    const current = await addIssue(t, publicationId, { publishedAt: Date.now() - 10 * DAY });
    await subscribe(t, userId, publicationId, { startedAt: Date.now() });
    const ids = await accessible(t, userId);
    expect(ids).toContain(current);
    expect(ids).not.toContain(older);
  });

  test("waehrend der Laufzeit erschienene Hefte werden freigeschaltet", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const start = Date.now() - 30 * DAY;
    await subscribe(t, userId, publicationId, { startedAt: start });
    const fresh = await addIssue(t, publicationId, { publishedAt: Date.now() - 2 * DAY });
    // Eine neue Ausgabe zieht die laufenden Abos nach.
    await t.mutation(internal.subscriptions.syncForIssueInternal, { issueId: fresh });
    const ids = await accessible(t, userId);
    expect(ids).toContain(fresh);
  });

  test("Kuendigung entzieht bereits freigeschaltete Hefte nicht", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { publishedAt: Date.now() - 5 * DAY });
    const subId = await subscribe(t, userId, publicationId, {
      startedAt: Date.now() - 20 * DAY,
    });
    await t.run(async (ctx: any) => {
      await ctx.db.patch(subId, { status: "canceled", endedAt: Date.now() - 1000 });
    });
    const ids = await accessible(t, userId);
    expect(ids).toContain(issueId);
  });

  test("Reaktivierung holt die Luecke nicht nach, aber das aktuelle Heft", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const inGap = await addIssue(t, publicationId, { publishedAt: Date.now() - 40 * DAY });
    const newest = await addIssue(t, publicationId, { publishedAt: Date.now() - 3 * DAY });
    // Erstes Abo endete vor der Luecke, das zweite startet jetzt.
    await subscribe(t, userId, publicationId, {
      startedAt: Date.now() - 90 * DAY,
      status: "canceled",
      endedAt: Date.now() - 60 * DAY,
    });
    await subscribe(t, userId, publicationId, { startedAt: Date.now() });
    const ids = await accessible(t, userId);
    expect(ids).toContain(newest);
    expect(ids).not.toContain(inGap);
  });

  test("past_due bleibt innerhalb der Kulanzfrist aktiv", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { publishedAt: Date.now() - 1 * DAY });
    await subscribe(t, userId, publicationId, {
      startedAt: Date.now() - 10 * DAY,
      status: "past_due",
      currentPeriodEnd: Date.now() - 1000,
    });
    const ids = await accessible(t, userId);
    expect(ids).toContain(issueId);
  });

  test("nicht veroeffentlichte Ausgabe wird vom Abo nicht freigeschaltet", async () => {
    const t = convexTest(schema, modules);
    const { userId, publicationId } = await setup(t);
    const draft = await addIssue(t, publicationId, { published: false });
    await subscribe(t, userId, publicationId, { startedAt: Date.now() - DAY });
    const ids = await accessible(t, userId);
    expect(ids).not.toContain(draft);
  });
});

describe("Shop-Schnittstelle", () => {
  test("ist idempotent und braucht ein vorhandenes Konto", async () => {
    const t = convexTest(schema, modules);
    const { publicationId } = await setup(t);
    const issueId = await addIssue(t, publicationId, { sku: "ZUERST-3-2026" });

    const missing = await t.mutation(internal.shopIntegration.applyInternal, {
      externalOrderId: "A-1",
      email: "unbekannt@example.de",
      issueSku: "ZUERST-3-2026",
      action: "grant",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("account_not_found");

    await t.run(async (ctx: any) => {
      // Konto darf noch unbestaetigt sein.
      await ctx.db.insert("users", { email: "kunde@example.de" });
    });
    const first = await t.mutation(internal.shopIntegration.applyInternal, {
      externalOrderId: "A-2",
      email: "kunde@example.de",
      issueSku: "ZUERST-3-2026",
      action: "grant",
    });
    expect(first.ok).toBe(true);
    const second = await t.mutation(internal.shopIntegration.applyInternal, {
      externalOrderId: "A-2",
      email: "kunde@example.de",
      issueSku: "ZUERST-3-2026",
      action: "grant",
    });
    expect(second.idempotent).toBe(true);

    const count = await t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("entitlements")
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      return rows.length;
    });
    expect(count).toBe(1);
  });
});
