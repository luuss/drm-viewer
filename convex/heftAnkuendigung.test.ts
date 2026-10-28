import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  deutscheZeitVersatz,
  heftMail,
  heftName,
  heftThema,
  themenAuswahl,
  versandZeit,
  type HeftMailDaten,
} from "./heftMail";
import { VERZUG_MS, abmeldeAdressen } from "./heftAnkuendigung";

const modules = import.meta.glob("./**/*.ts");
const MIN = 60 * 1000;

describe("Vorlage", () => {
  const dmz = { reiheSlug: "dmz", reiheName: "Deutsche Militärzeitschrift" };

  test("Heftname mit Kurzname der Reihe, wo die Bezeichnung ihn nicht traegt", () => {
    expect(heftName({ ...dmz, bezeichnung: "DMZ Nr. 170", heftTitel: "Fernspäher" })).toBe("DMZ Nr. 170");
    expect(
      heftName({ reiheSlug: "zuerst", reiheName: "ZUERST!", bezeichnung: "Dezember 2025", heftTitel: "ZUERST!" }),
    ).toBe("ZUERST! Dezember 2025");
    expect(
      heftName({
        reiheSlug: "dmz-zeitgeschichte",
        reiheName: "DMZ Zeitgeschichte",
        bezeichnung: "DMZ-ZG Nr. 80",
        heftTitel: "Mscha 1943",
      }),
    ).toBe("DMZ-ZG Nr. 80");
    expect(heftName({ ...dmz, bezeichnung: null, heftTitel: "DMZ 171" })).toBe("DMZ 171");
  });

  test("Titelthema nur, wenn der Titel mehr sagt als die Reihe", () => {
    expect(heftThema({ ...dmz, bezeichnung: "DMZ Nr. 170", heftTitel: "Fernspäher" })).toBe("Fernspäher");
    expect(
      heftThema({ reiheSlug: "zuerst", reiheName: "ZUERST!", bezeichnung: "März 2026", heftTitel: "ZUERST!" }),
    ).toBeNull();
    expect(heftThema({ ...dmz, bezeichnung: null, heftTitel: "Dmz 171" })).toBeNull();
  });

  test("Themen ohne feste Rubriken, ohne Titelthema, ohne Doppel", () => {
    const auswahl = themenAuswahl(
      [
        { titel: "Editorial" },
        { titel: "Fernspäher", unterzeile: "Elite" },
        { titel: "Verrat an der Truppe", unterzeile: "  Wie   es kam " },
        { titel: "Kalenderblatt – Ereignisse" },
        { titel: "Verrat an der Truppe" },
        { titel: "Auge des Heeres" },
        { titel: "Buchbesprechungen" },
        { titel: "Impressum" },
      ],
      "Fernspäher",
    );
    expect(auswahl).toEqual([
      { titel: "Verrat an der Truppe", unterzeile: "Wie es kam" },
      { titel: "Auge des Heeres", unterzeile: null },
    ]);
  });

  test("nie nachts: zwischen 21 und 8 Uhr deutscher Zeit geht die Mail um 8", () => {
    // 28.10.2026 ist Winterzeit (UTC+1), 15.07.2026 Sommerzeit (UTC+2).
    expect(deutscheZeitVersatz(Date.UTC(2026, 9, 28, 12))).toBe(60 * MIN);
    expect(deutscheZeitVersatz(Date.UTC(2026, 6, 15, 12))).toBe(120 * MIN);
    const mittag = Date.UTC(2026, 9, 28, 11, 30);
    expect(versandZeit(mittag)).toBe(mittag);
    // 22:30 deutscher Zeit → naechster Morgen 8:00 = 7:00 UTC
    expect(versandZeit(Date.UTC(2026, 9, 28, 21, 30))).toBe(Date.UTC(2026, 9, 29, 7, 0));
    // 3:00 deutscher Zeit im Sommer → 8:00 desselben Tages = 6:00 UTC
    expect(versandZeit(Date.UTC(2026, 6, 15, 1, 0))).toBe(Date.UTC(2026, 6, 15, 6, 0));
  });

  const daten: HeftMailDaten = {
    appUrl: "https://digital.lesenundschenken.de",
    ...dmz,
    heftTitel: "Fernspäher <Elite>",
    bezeichnung: "DMZ Nr. 170",
    untertitel: "Ausgabe März/April 2026",
    preisCents: 980,
    umschlagUrl: "https://digital.lesenundschenken.de/api/asset/abc.jpg",
    heftPfad: "/issue/dmz-170",
    themen: [{ titel: "Auge des Heeres", unterzeile: "Aufklärung" }],
    aboPfad: "/abo/dmz",
  };
  const adressen = abmeldeAdressen(daten.appUrl, "T0K", "dmz");

  test("Mail fuer Nicht-Besitzer: Preis, Abo-Hinweis, Abmeldelinks, alles maskiert", () => {
    const m = heftMail(daten, { zugang: false, ...adressen });
    expect(m.betreff).toBe("DMZ Nr. 170 ist erschienen: Fernspäher Elite");
    expect(m.html).toContain("Fernspäher &lt;Elite&gt;");
    expect(m.html).not.toContain("<Elite>");
    expect(m.html).toContain("Heft ansehen");
    expect(m.html).toContain("Digitalausgabe 9,80 €");
    expect(m.html).toContain("https://digital.lesenundschenken.de/abo/dmz");
    expect(m.html).toContain("#c4161c");
    expect(m.html).toContain("https://digital.lesenundschenken.de/img/dmz-logo.png");
    expect(m.html).toContain("https://digital.lesenundschenken.de/abbestellen?t=T0K&amp;r=dmz");
    expect(m.text).toContain("Heft ansehen: https://digital.lesenundschenken.de/issue/dmz-170");
    expect(m.text).toContain("– Auge des Heeres: Aufklärung");
    expect(m.text).toContain("„Deutsche Militärzeitschrift“ abbestellen: https://digital.lesenundschenken.de/abbestellen?t=T0K&r=dmz");
    // Jede Adresse in der Mail zeigt auf den Leser (das prueft auch der Laden).
    for (const [, url] of m.html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      expect(url.startsWith("https://digital.lesenundschenken.de/")).toBe(true);
    }
  });

  test("Mail fuer Besitzer: Jetzt lesen, kein Preis, kein Abo-Hinweis", () => {
    const m = heftMail(daten, { zugang: true, ...adressen });
    expect(m.html).toContain("Jetzt lesen");
    expect(m.html).toContain("steht schon in Ihrer Bibliothek bereit");
    expect(m.html).not.toContain("9,80");
    expect(m.html).not.toContain("/abo/dmz");
  });
});

// --- Ablauf mit Datenbank ----------------------------------------------------

type T = ReturnType<typeof convexTest>;

async function anlegen(t: T) {
  return await t.run(async (ctx: any) => {
    const now = Date.now();
    const publicationId = await ctx.db.insert("publications", {
      name: "Deutsche Militärzeitschrift",
      slug: "dmz",
      isActive: true,
      createdAt: now,
    });
    const zuerstId = await ctx.db.insert("publications", {
      name: "ZUERST!",
      slug: "zuerst",
      isActive: true,
      createdAt: now + 1,
    });
    const heft = (extra: Record<string, unknown>) => ({
      publicationId,
      pageCount: 1,
      priceAmountCents: 980,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    const altId = await ctx.db.insert("issues", heft({ title: "DMZ 169", slug: "dmz-169" }));
    await ctx.db.insert("issues", {
      ...heft({ title: "ZUERST! 1/2026", slug: "zuerst-1-2026" }),
      publicationId: zuerstId,
      isPublished: true,
      publishedAt: now,
    });
    const issueId = await ctx.db.insert(
      "issues",
      heft({ title: "Fernspäher", slug: "dmz-170", shopDesignation: "DMZ Nr. 170" }),
    );
    const assetId = await ctx.db.insert("assets", { key: "p/1.jpg", contentType: "image/jpeg", kind: "page", createdAt: now });
    for (const id of [altId, issueId]) {
      await ctx.db.insert("issuePages", {
        issueId: id,
        index: 0,
        role: "content",
        sourceAssetId: assetId,
        sourcePageIndex: 0,
        width: 100,
        height: 140,
      });
    }
    const shop = (email: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("shopAccess", {
        email,
        externalOrderId: `o-${email}`,
        lineId: "1",
        sku: "X",
        kind: "issue",
        issueId: altId,
        createdAt: now,
        updatedAt: now,
        ...extra,
      });
    await shop("gast@example.de");
    await shop("erstattet@example.de", { revokedAt: now });
    await shop("abo@example.de", {
      kind: "subscription",
      issueId: undefined,
      publicationId,
      validFrom: now - 1000,
      validUntil: now + 10_000_000,
    });
    await shop("GAST@example.de ", { externalOrderId: "o-2" });
    const kontoId = await ctx.db.insert("users", { email: "konto@example.de" });
    await ctx.db.insert("entitlements", { userId: kontoId, issueId: altId, source: "purchase", createdAt: now });
    const geschenktId = await ctx.db.insert("users", { email: "geschenk@example.de" });
    await ctx.db.insert("entitlements", { userId: geschenktId, issueId: altId, source: "gift", createdAt: now });
    const redaktionId = await ctx.db.insert("users", { email: "redaktion@example.de", roles: ["publisher"] });
    return { issueId, altId, publicationId, zuerstId, redaktionId };
  });
}

async function zeilen(t: T) {
  return await t.run(async (ctx: any) => ({
    ankuendigungen: await ctx.db.query("heftAnkuendigungen").collect(),
    empfaenger: await ctx.db.query("heftAnkuendigungEmpfaenger").collect(),
  }));
}

describe("Ablauf", () => {
  let gesendet: any[];
  let antwort: (body: any) => Response;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 28, 10, 0)));
    vi.stubEnv("SHOP_WEBHOOK_SECRET", "geheim");
    vi.stubEnv("APP_PUBLIC_URL", "https://digital.lesenundschenken.de");
    gesendet = [];
    antwort = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        gesendet.push(body);
        return antwort(body);
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function veroeffentlichen(t: T, redaktionId: Id<"users">, issueId: Id<"issues">, an = true) {
    await t.withIdentity({ subject: `${redaktionId}|s` }).mutation(api.issues.setPublished, { issueId, isPublished: an });
  }

  test("erstes Veroeffentlichen: jeder Kaeufer genau einmal, Abo-Kunde mit Lesen-Knopf", async () => {
    const t = convexTest(schema, modules);
    const { issueId, redaktionId } = await anlegen(t);
    await veroeffentlichen(t, redaktionId, issueId);

    let { ankuendigungen } = await zeilen(t);
    expect(ankuendigungen).toHaveLength(1);
    expect(ankuendigungen[0].status).toBe("geplant");
    expect(ankuendigungen[0].geplantFuer).toBe(Date.now() + VERZUG_MS);
    expect(gesendet).toHaveLength(0);

    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const an = gesendet.map((g) => g.to).sort();
    expect(an).toEqual(["abo@example.de", "gast@example.de", "konto@example.de"]);
    expect(gesendet.every((g) => g.action === "heft_mail")).toBe(true);
    const abo = gesendet.find((g) => g.to === "abo@example.de");
    expect(abo.html).toContain("Jetzt lesen");
    const gast = gesendet.find((g) => g.to === "gast@example.de");
    expect(gast.html).toContain("Heft ansehen");
    expect(gast.subject).toBe("DMZ Nr. 170 ist erschienen: Fernspäher");
    expect(gast.unsubscribe).toMatch(
      /^https:\/\/digital\.lesenundschenken\.de\/hooks\/mail\/abbestellen\?t=[A-Za-z0-9_-]{43}&r=dmz$/,
    );

    ({ ankuendigungen } = await zeilen(t));
    expect(ankuendigungen[0]).toMatchObject({ status: "fertig", empfaenger: 3, gesendet: 3, fehler: 0 });

    // Zurueckziehen und wieder veroeffentlichen: keine zweite Mail.
    await veroeffentlichen(t, redaktionId, issueId, false);
    await veroeffentlichen(t, redaktionId, issueId);
    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gesendet).toHaveLength(3);
  });

  test("Abbestellen je Reihe und alle; wer abbestellt hat, bekommt nichts", async () => {
    const t = convexTest(schema, modules);
    const { issueId, redaktionId, publicationId, zuerstId } = await anlegen(t);
    // Erste Mail an alle, damit es Schluessel gibt.
    await veroeffentlichen(t, redaktionId, issueId);
    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const token = new URL(gesendet.find((g) => g.to === "gast@example.de").unsubscribe).searchParams.get("t")!;

    let e = await t.query(api.heftAnkuendigung.einstellungenMitSchluessel, { token });
    expect(e!.adresse).toBe("g•••@example.de");
    expect(e!.reihen.map((r: any) => [r.slug, r.erhalten])).toEqual([
      ["dmz", true],
      ["zuerst", true],
    ]);

    // Ein-Klick aus dem Mailprogramm: nur die DMZ.
    const res = await t.fetch(`/mail/abbestellen?t=${token}&r=dmz`, { method: "POST" });
    expect(res.status).toBe(200);
    e = await t.query(api.heftAnkuendigung.einstellungenMitSchluessel, { token });
    expect(e!.reihen.map((r: any) => r.erhalten)).toEqual([false, true]);

    // GET (Linkpruefer) aendert nichts, fuehrt nur zur Seite.
    const get = await t.fetch(`/mail/abbestellen?t=${token}&r=zuerst`, { method: "GET" });
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe(`https://digital.lesenundschenken.de/abbestellen?t=${token}&r=zuerst`);

    // Alle abbestellen, dann nur ZUERST! wieder an.
    await t.mutation(api.heftAnkuendigung.einstellenMitSchluessel, { token, erhalten: false });
    e = await t.query(api.heftAnkuendigung.einstellungenMitSchluessel, { token });
    expect(e!.alleAbbestellt).toBe(true);
    expect(e!.reihen.every((r: any) => !r.erhalten)).toBe(true);
    await t.mutation(api.heftAnkuendigung.einstellenMitSchluessel, { token, publicationId: zuerstId, erhalten: true });
    e = await t.query(api.heftAnkuendigung.einstellungenMitSchluessel, { token });
    expect(e!.alleAbbestellt).toBe(false);
    expect(e!.reihen.map((r: any) => r.erhalten)).toEqual([false, true]);

    // Neues DMZ-Heft: gast@ ist fuer die DMZ abbestellt.
    const neuId = await t.run(async (ctx: any) => {
      const now = Date.now();
      const id = await ctx.db.insert("issues", {
        publicationId,
        title: "DMZ 171",
        slug: "dmz-171",
        pageCount: 1,
        priceAmountCents: 980,
        isPublished: false,
        includedInSubscription: true,
        createdAt: now,
        updatedAt: now,
      });
      const assetId = await ctx.db.insert("assets", { key: "p/2.jpg", contentType: "image/jpeg", kind: "page", createdAt: now });
      await ctx.db.insert("issuePages", {
        issueId: id,
        index: 0,
        role: "content",
        sourceAssetId: assetId,
        sourcePageIndex: 0,
        width: 100,
        height: 140,
      });
      return id;
    });
    gesendet = [];
    await veroeffentlichen(t, redaktionId, neuId);
    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gesendet.map((g) => g.to).sort()).toEqual(["abo@example.de", "konto@example.de"]);
    const { ankuendigungen } = await zeilen(t);
    const neu = ankuendigungen.find((a: any) => a.issueId === neuId);
    expect(neu).toMatchObject({ status: "fertig", empfaenger: 3, gesendet: 2, abgemeldet: 1 });
  });

  test("zurueckgezogen vor dem Versand: nichts geht raus, beim erneuten Veroeffentlichen schon", async () => {
    const t = convexTest(schema, modules);
    const { issueId, redaktionId } = await anlegen(t);
    await veroeffentlichen(t, redaktionId, issueId);
    await veroeffentlichen(t, redaktionId, issueId, false);
    let { ankuendigungen } = await zeilen(t);
    expect(ankuendigungen[0]).toMatchObject({ status: "abgebrochen", grund: "zurueckgezogen" });
    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gesendet).toHaveLength(0);

    await veroeffentlichen(t, redaktionId, issueId);
    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gesendet).toHaveLength(3);
    ({ ankuendigungen } = await zeilen(t));
    expect(ankuendigungen).toHaveLength(1);
  });

  test("Redaktion stoppt; Laden voruebergehend weg: neuer Versuch, Fehler nach drei", async () => {
    const t = convexTest(schema, modules);
    const { issueId, redaktionId } = await anlegen(t);
    const redaktion = t.withIdentity({ subject: `${redaktionId}|s` });
    await veroeffentlichen(t, redaktionId, issueId);
    await redaktion.mutation(api.heftAnkuendigung.stoppen, { issueId });
    vi.advanceTimersByTime(VERZUG_MS + 1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gesendet).toHaveLength(0);
    let stand = await redaktion.query(api.heftAnkuendigung.fuerRedaktion, { issueId });
    expect(stand.ankuendigung).toMatchObject({ status: "abgebrochen", grund: "gestoppt" });

    // Der Laden ist zweimal ganz weg, dann wieder da; gast@ hat schon zu
    // viele Mails bekommen.
    let ausfaelle = 6;
    antwort = (body) => {
      if (ausfaelle-- > 0) return new Response("Bad Gateway", { status: 502 });
      return body.to === "gast@example.de"
        ? new Response(JSON.stringify({ ok: false, error: "rate_limited" }), { status: 429 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await redaktion.mutation(api.heftAnkuendigung.jetztSenden, { issueId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(gesendet.filter((g) => g.to === "gast@example.de")).toHaveLength(3);
    stand = await redaktion.query(api.heftAnkuendigung.fuerRedaktion, { issueId });
    expect(stand.ankuendigung).toMatchObject({ status: "fertig", gesendet: 2, fehler: 1 });
  });

  test("Kontoloeschung bestellt alles ab", async () => {
    const t = convexTest(schema, modules);
    await anlegen(t);
    const userId = await t.run(async (ctx: any) =>
      (await ctx.db.query("users").withIndex("email", (q: any) => q.eq("email", "konto@example.de")).first())._id,
    );
    await t.mutation(internal.account.purgeUserData, { userId });
    const zeile = await t.run(async (ctx: any) =>
      ctx.db.query("mailEinstellungen").withIndex("by_email", (q: any) => q.eq("email", "konto@example.de")).first(),
    );
    expect(zeile.alleAbbestellt).toBe(true);
  });
});
