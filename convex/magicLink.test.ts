import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { sha256Hex } from "./magicLink";
import {
  LINK_TTL_MS,
  MAX_PER_EMAIL_PER_HOUR,
  MAX_PER_IP_PER_HOUR,
  buildLoginLink,
  isPlausibleEmail,
  safeNext,
} from "./magicLinkRules";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60 * 1000;

async function request(t: any, email: string, ip = "1.2.3.4", next = "/library") {
  return await t.mutation(internal.magicLink.requestInternal, { email, ip, next });
}

async function consume(t: any, token: string) {
  return await t.mutation(internal.magicLink.consumeInternal, { token });
}

async function grund(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    return e?.data?.grund ?? String(e?.message ?? e);
  }
  return "kein Fehler";
}

describe("Regeln", () => {
  test("Zielpfad nur auf derselben Seite", () => {
    expect(safeNext("/issue/zuerst-3")).toBe("/issue/zuerst-3");
    expect(safeNext("/warenkorb?x=1#k")).toBe("/warenkorb?x=1#k");
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/login",
      "/anmelden?t=abc",
      "/claim/xyz",
      "/a b",
      "/a\nb",
      "",
      null,
      42,
    ]) {
      expect(safeNext(bad)).toBe("/library");
    }
  });

  test("Link enthaelt Token und nur abweichendes Ziel", () => {
    expect(buildLoginLink("https://lesen.lesenundschenken.de/", "abc", "/library")).toBe(
      "https://lesen.lesenundschenken.de/anmelden?t=abc",
    );
    expect(buildLoginLink("https://lesen.lesenundschenken.de", "abc", "/issue/x")).toBe(
      "https://lesen.lesenundschenken.de/anmelden?t=abc&next=%2Fissue%2Fx",
    );
  });

  test("Adresspruefung", () => {
    expect(isPlausibleEmail("kunde@example.de")).toBe(true);
    expect(isPlausibleEmail("kunde@example")).toBe(false);
    expect(isPlausibleEmail("a b@example.de")).toBe(false);
    expect(isPlausibleEmail("<x>@example.de")).toBe(false);
  });
});

describe("Link anfordern und einloesen", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("Token wird nur gehasht gespeichert, Konto entsteht erst beim Klick", async () => {
    const t = convexTest(schema, modules);
    const res = await request(t, "  Neu@Example.DE ");
    expect(res.ok).toBe(true);
    const rows = await t.run((ctx: any) => ctx.db.query("magicLinks").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("neu@example.de");
    expect(rows[0].tokenHash).toBe(await sha256Hex(res.token));
    expect(JSON.stringify(rows[0])).not.toContain(res.token);
    expect(await t.run((ctx: any) => ctx.db.query("users").collect())).toHaveLength(0);

    const { userId } = await consume(t, res.token);
    const user = await t.run((ctx: any) => ctx.db.get(userId));
    expect(user.email).toBe("neu@example.de");
    expect(user.emailVerificationTime).toBeTypeOf("number");
  });

  test("ein Link gilt nur einmal", async () => {
    const t = convexTest(schema, modules);
    const res = await request(t, "kunde@example.de");
    await consume(t, res.token);
    expect(await grund(consume(t, res.token))).toBe("benutzt");
  });

  test("nach 15 Minuten abgelaufen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T10:00:00Z"));
    const t = convexTest(schema, modules);
    const res = await request(t, "kunde@example.de");
    vi.setSystemTime(new Date(Date.now() + LINK_TTL_MS + 1000));
    expect(await grund(consume(t, res.token))).toBe("abgelaufen");
  });

  test("unbekanntes Token", async () => {
    const t = convexTest(schema, modules);
    expect(await grund(consume(t, "x".repeat(43)))).toBe("unbekannt");
  });

  test("bestehendes Passwortkonto behaelt Id, Rollen und Freischaltungen", async () => {
    const t = convexTest(schema, modules);
    const { userId, issueId } = await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { email: "alt@example.de", roles: ["editor"] });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "password",
        providerAccountId: "alt@example.de",
        secret: "hash",
      });
      const publicationId = await ctx.db.insert("publications", {
        name: "ZUERST!",
        slug: "zuerst",
        isActive: true,
        createdAt: Date.now(),
      });
      const issueId = await ctx.db.insert("issues", {
        publicationId,
        title: "Heft",
        slug: "heft",
        isPublished: true,
        includedInSubscription: true,
        pageCount: 1,
        priceAmountCents: 490,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("entitlements", {
        userId,
        issueId,
        source: "purchase",
        createdAt: Date.now(),
      });
      return { userId, issueId };
    });
    const res = await request(t, "ALT@example.de");
    const out = await consume(t, res.token);
    expect(out.userId).toBe(userId);
    const after = await t.run(async (ctx: any) => ({
      users: await ctx.db.query("users").collect(),
      accounts: await ctx.db.query("authAccounts").collect(),
      ents: await ctx.db.query("entitlements").collect(),
    }));
    expect(after.users).toHaveLength(1);
    expect(after.users[0].roles).toEqual(["editor"]);
    expect(after.accounts.map((a: any) => a.provider).sort()).toEqual(["magic-link", "password"]);
    expect(after.ents[0].issueId).toBe(issueId);
  });

  test("offene Einloeselinks aus Gastkaeufen werden eingeloest, erstattete nicht", async () => {
    const t = convexTest(schema, modules);
    const { issueA, issueB } = await t.run(async (ctx: any) => {
      const publicationId = await ctx.db.insert("publications", {
        name: "DMZ",
        slug: "dmz",
        isActive: true,
        createdAt: Date.now(),
      });
      const mk = (slug: string) =>
        ctx.db.insert("issues", {
          publicationId,
          title: slug,
          slug,
          isPublished: true,
          includedInSubscription: true,
          pageCount: 1,
          priceAmountCents: 490,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      const issueA = await mk("a");
      const issueB = await mk("b");
      for (const [issueId, session, status] of [
        [issueA, "cs_a", "paid"],
        [issueB, "cs_b", "refunded"],
      ] as const) {
        await ctx.db.insert("purchases", {
          email: "gast@example.de",
          issueId,
          stripeSessionId: session,
          amountCents: 490,
          status,
          createdAt: Date.now(),
        });
        await ctx.db.insert("claimTokens", {
          token: `t-${session}`,
          issueId,
          email: "gast@example.de",
          stripeSessionId: session,
          expiresAt: Date.now() - DAY,
          createdAt: Date.now() - 40 * DAY,
        });
      }
      return { issueA, issueB };
    });
    const res = await request(t, "gast@example.de");
    const { userId } = await consume(t, res.token);
    const ents = await t.run((ctx: any) => ctx.db.query("entitlements").collect());
    expect(ents.map((e: any) => e.issueId)).toEqual([issueA]);
    expect(ents[0].userId).toBe(userId);
    void issueB;
  });

  test("Grenzen je Adresse und je IP", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < MAX_PER_EMAIL_PER_HOUR; i++) {
      expect((await request(t, "viel@example.de", `9.9.9.${i}`)).ok).toBe(true);
    }
    expect(await request(t, "viel@example.de", "9.9.9.200")).toEqual({
      ok: false,
      reason: "rate_email",
    });
    for (let i = 0; i < MAX_PER_IP_PER_HOUR; i++) {
      expect((await request(t, `k${i}@example.de`, "5.5.5.5")).ok).toBe(true);
    }
    expect(await request(t, "noch@example.de", "5.5.5.5")).toEqual({
      ok: false,
      reason: "rate_ip",
    });
  });
});

describe("hoechstens zwei angemeldete Browser", () => {
  async function login(t: any, userId: Id<"users">) {
    return await t.run(async (ctx: any) => {
      const { makeRoomForLogin } = await import("./sessions");
      await makeRoomForLogin(ctx, userId);
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 30 * DAY,
      });
      await ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 30 * DAY,
      });
      return sessionId as Id<"authSessions">;
    });
  }

  test("die dritte Anmeldung beendet die aelteste samt Tokens und Lesesitzungen", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx: any) => ctx.db.insert("users", { email: "k@example.de" }));
    const s1 = await login(t, userId);
    const s2 = await login(t, userId);
    const reader = await t.run(async (ctx: any) => {
      const publicationId = await ctx.db.insert("publications", {
        name: "P",
        slug: "p",
        isActive: true,
        createdAt: Date.now(),
      });
      const issueId = await ctx.db.insert("issues", {
        publicationId,
        title: "H",
        slug: "h",
        isPublished: true,
        includedInSubscription: true,
        pageCount: 1,
        priceAmountCents: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("readerSessions", {
        userId,
        authSessionId: s1,
        sessionToken: "lese-token",
        issueId,
        createdAt: Date.now(),
        expiresAt: Date.now() + DAY,
      });
    });
    void reader;
    const s3 = await login(t, userId);

    const state = await t.run(async (ctx: any) => ({
      sessions: (await ctx.db.query("authSessions").collect()).map((s: any) => s._id),
      tokens: (await ctx.db.query("authRefreshTokens").collect()).map((r: any) => r.sessionId),
      reader: await ctx.db.query("readerSessions").collect(),
    }));
    expect(state.sessions.sort()).toEqual([s2, s3].sort());
    expect(state.tokens).not.toContain(s1);
    expect(state.reader).toHaveLength(0);

    const asFirst = t.withIdentity({ subject: `${userId}|${s1}` });
    expect(await asFirst.query(api.sessions.current, {})).toEqual({ alive: false });
    const asThird = t.withIdentity({ subject: `${userId}|${s3}` });
    expect(await asThird.query(api.sessions.current, {})).toEqual({ alive: true });
  });

  test("Kontoseite: fremde Anmeldungen lassen sich nicht beenden", async () => {
    const t = convexTest(schema, modules);
    const a = await t.run((ctx: any) => ctx.db.insert("users", { email: "a@example.de" }));
    const b = await t.run((ctx: any) => ctx.db.insert("users", { email: "b@example.de" }));
    const sa = await login(t, a);
    const sb = await login(t, b);
    const asA = t.withIdentity({ subject: `${a}|${sa}` });
    await expect(asA.mutation(api.sessions.revoke, { sessionId: sb })).rejects.toThrow();
    const list = await asA.query(api.sessions.mine, {});
    expect(list.map((s: any) => s._id)).toEqual([sa]);
    expect(list[0].current).toBe(true);
    expect(await asA.mutation(api.sessions.revoke, { sessionId: sa })).toEqual({ current: true });
  });
});

describe("HTTP /auth/link", () => {
  const sent: any[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubEnv("SHOP_WEBHOOK_SECRET", "geheim");
    vi.stubEnv("APP_PUBLIC_URL", "https://lesen.lesenundschenken.de");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        sent.push({ body: JSON.parse(init.body), signature: init.headers["x-shop-signature"] });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function post(t: any, body: unknown, ip = "7.7.7.7") {
    return await t.fetch("/auth/link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    });
  }

  test("schickt den Link ueber die Shop-API, gleiche Antwort fuer jede Adresse", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, { email: "Leser@Example.de", next: "/issue/heft" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].body.action).toBe("send_mail");
    expect(sent[0].body.template).toBe("lusdigital_login");
    expect(sent[0].body.to).toBe("leser@example.de");
    expect(sent[0].body.link).toMatch(
      /^https:\/\/lesen\.lesenundschenken\.de\/anmelden\?t=[A-Za-z0-9_-]{43}&next=%2Fissue%2Fheft$/,
    );
    expect(sent[0].signature).toMatch(/^[0-9a-f]{64}$/);
    const rows = await t.run((ctx: any) => ctx.db.query("magicLinks").collect());
    expect(rows[0].ip).toBe("7.7.7.7");
  });

  test("fremdes Ziel wird zur Bibliothek", async () => {
    const t = convexTest(schema, modules);
    await post(t, { email: "leser@example.de", next: "https://evil.example" });
    expect(sent[0].body.link).not.toContain("next=");
  });

  test("Fehler: Adresse, Grenze, Shop", async () => {
    const t = convexTest(schema, modules);
    expect((await post(t, { email: "kaputt" })).status).toBe(400);
    for (let i = 0; i < MAX_PER_EMAIL_PER_HOUR; i++) {
      expect((await post(t, { email: "x@example.de" }, `8.8.8.${i}`)).status).toBe(200);
    }
    expect((await post(t, { email: "x@example.de" }, "8.8.8.99")).status).toBe(429);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "mail_failed" }), { status: 502 })),
    );
    expect((await post(t, { email: "y@example.de" })).status).toBe(502);
    const row = await t.run((ctx: any) =>
      ctx.db
        .query("magicLinks")
        .withIndex("by_email_and_createdAt", (q: any) => q.eq("email", "y@example.de"))
        .first(),
    );
    expect(row.sendError).toBeTruthy();
  });
});
