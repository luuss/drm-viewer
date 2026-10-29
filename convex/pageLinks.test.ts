import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  bookQueries,
  chooseBook,
  chooseFromAd,
  openBookTarget,
  splitBookLabel,
  textUnderLink,
  searchWords,
  chooseProduct,
  chooseTarget,
  titleRank,
  defaultSubscriptionUrl,
  searchUrl,
  seriesUrl,
} from "./pageLinks";

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
  test("Nachruesten ersetzt nur die Buchflaechen", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const buch = (titel: string) => ({
      pageIndex: 78,
      x0: 0.05,
      y0: 0.07,
      x1: 0.21,
      y1: 0.34,
      kind: "shop" as const,
      queries: [titel],
      single: true,
      label: `${titel} · Peter Hahne`,
    });
    await t.mutation(internal.pageLinks.replaceImportedInternal, {
      issueId,
      links: [
        { pageIndex: 83, x0: 0, y0: 0, x1: 1, y1: 1, kind: "shop", queries: ["Zeugen"], label: "Zeugen" },
        buch("Alter Titel"),
      ],
    });
    const result = await t.mutation(internal.pageLinks.replaceBooksInternal, {
      issueId,
      links: [buch("Warum macht ihr uns kaputt?")],
    });
    expect(result).toEqual({ removed: 1, added: 1 });
    const labels = await t.run(async (ctx: any) =>
      (
        await ctx.db
          .query("pageLinks")
          .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
          .collect()
      ).map((r: any) => r.label ?? "-"),
    );
    expect(labels.sort()).toEqual(
      ["Warum macht ihr uns kaputt? · Peter Hahne", "Zeugen", "-"].sort(),
    );
  });

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
    expect(seriesUrl("schwertertraeger")).toBe(
      "https://lesenundschenken.de/zeitschriften/schwertertraeger",
    );
    expect(searchUrl("Waffen-SS")).toBe("https://lesenundschenken.de/suche?s=Waffen-SS");
  });

  test("ein Produkt nur bei genau einem Treffer", () => {
    const produkt = (id: number, reference: string, active = true) => ({
      id,
      name: `Buch ${id}`,
      reference,
      priceCents: 2980,
      url: `https://lesenundschenken.de/${id}-buch.html`,
      coverUrl: null,
      manufacturer: "",
      active,
      digital: null,
    });
    expect(chooseProduct([produkt(1, "101208")])?.id).toBe(1);
    expect(chooseProduct([produkt(1, "101208"), produkt(2, "101209")])).toBeNull();
    expect(chooseProduct([produkt(1, "101208"), produkt(2, "101209")], "101209")?.id).toBe(2);
    expect(chooseProduct([produkt(1, "101208", false)])).toBeNull();
    expect(chooseProduct([])).toBeNull();
  });

  test("Einzelanzeige zur Produktseite, Sammelanzeige zur Liste", () => {
    const produkt = (id: number) => ({
      id,
      name: `Buch ${id}`,
      reference: String(100000 + id),
      priceCents: 2980,
      url: `https://lesenundschenken.de/${id}-buch.html`,
      coverUrl: null,
      manufacturer: "",
      active: true,
      digital: null,
    });
    const viele = (n: number) => Array.from({ length: n }, (_, i) => produkt(i + 1));
    // Ein Buch: der Titel trifft genau eines.
    expect(
      chooseTarget(
        [
          { q: "Ulrich Steinmetz", products: viele(3) },
          { q: "Zeugen deutscher Geschichte", products: [produkt(9)] },
        ],
        true,
      ),
    ).toBe("https://lesenundschenken.de/9-buch.html");
    // Mehrere Buecher eines Verfassers: seine Liste, nicht das eine Buch, das
    // ein einzelnes Wort zufaellig trifft.
    expect(
      chooseTarget(
        [
          { q: "Stefan Scheil", products: viele(8) },
          { q: "Der Historiker", products: [produkt(4)] },
          { q: "Historiker", products: viele(20) },
        ],
        false,
      ),
    ).toBe(searchUrl("Stefan Scheil"));
    // Sammelanzeige ohne Verfasser: der Begriff mit den meisten Treffern.
    expect(
      chooseTarget(
        [
          { q: "Bücher zur Geschichte der Waffen-SS", products: [produkt(1)] },
          { q: "Waffen-SS", products: viele(12) },
        ],
        false,
      ),
    ).toBe(searchUrl("Waffen-SS"));
    expect(chooseTarget([], true)).toBeNull();
  });

  test("Buchflaeche: nur ein Produkt mit passendem Titel", () => {
    let id = 0;
    const produkt = (name: string, manufacturer = "", reference = "") => ({
      id: ++id,
      name,
      reference,
      priceCents: 2000,
      url: `https://lesenundschenken.de/${id}-buch.html`,
      coverUrl: null,
      manufacturer,
      active: true,
      digital: null,
    });
    // Echte Treffer der Ladensuche zu den Buechern aus ZUERST! 3/2026, S. 79.
    const mythos = produkt("Der Stasi-Mythos");
    const stasi = produkt("STASI", "Klaus-Rüdiger Mai");
    expect(chooseBook([mythos, stasi], "Stasi · Klaus-Rüdiger Mai")?.id).toBe(stasi.id);
    const werk = produkt("Merkels Werk", "Gerald Grosz");
    const jahre = produkt("16 Jahre Angela Merkel");
    expect(chooseBook([jahre, werk], "Merkels Werk · Gerald Grosz")?.id).toBe(werk.id);
    const ddr = produkt("DDR - CDU - AfD");
    expect(chooseBook([ddr], "DDR – CDU – AfD · Alexander Gauland")?.id).toBe(ddr.id);
    const jahrbuch = produkt("Verheimlicht - Vertuscht - Vergessen 2026");
    expect(
      chooseBook([jahrbuch], "Verheimlicht, vertuscht, vergessen 2026 · Gerhard Wisnewski")?.id,
    ).toBe(jahrbuch.id);
    // Ein einziger Treffer der Suche, aber ein anderes Buch: keine Produktseite.
    expect(
      chooseBook([produkt("Europa - Grenzenlos")], "An der Grenze · Jan Solwyn"),
    ).toBeNull();
    // Untertitel im Laden zaehlt als passend.
    const kling = produkt("Heinrich Kling - Ein Tiger-As der Leibstandarte");
    expect(chooseBook([kling], "Heinrich Kling · Danny Bauer")?.id).toBe(kling.id);
    // Zwei Baende gleichen Namens: offen, die Suchseite zeigt beide.
    expect(
      chooseBook([produkt("Unbekannt - April 1945"), produkt("Unbekannt - April 1945")],
        "Unbekannt – April 1945 · Henrik Schulze"),
    ).toBeNull();
    // Gleichstand im Titel: der Verfasser entscheidet.
    const a = produkt("Kriegs-Kultur", "Martin van Creveld");
    const b = produkt("Kriegs-Kultur", "Jemand Anders");
    expect(chooseBook([b, a], "Kriegs-Kultur · Martin van Creveld")?.id).toBe(a.id);
    // Artikelnummer vor Titel.
    const kalender = produkt("Ritterkreuzträger 2026", "", "460691");
    expect(chooseBook([kalender], "Farbbildkalender: Ritterkreuzträger · ", "460691")?.id).toBe(
      kalender.id,
    );
  });

  test("Titelstufen", () => {
    expect(titleRank("STASI", "Stasi")).toBe(3);
    expect(titleRank("Die deutsche Militärelite 1939-1945", "Die deutsche Militärelite")).toBe(2);
    expect(titleRank("Der Stasi-Mythos", "Stasi")).toBe(0);
    expect(titleRank("Panther im Einsatz II", "„Panther“ im Einsatz II")).toBe(3);
  });
});

describe("bookQueries", () => {
  test("nimmt Satzzeichen heraus, die die Ladensuche nie findet", () => {
    expect(searchWords("DDR – CDU – AfD")).toBe("DDR CDU AfD");
    expect(searchWords("„Panther“ im Einsatz II")).toBe("Panther im Einsatz II");
  });

  test("sucht zusaetzlich nur mit dem Haupttitel, ohne Jahreszahl", () => {
    const q = bookQueries(
      "Verheimlicht, vertuscht, vergessen 2026 · Gerhard Wisnewski",
      null,
      ["Verheimlicht, vertuscht, vergessen 2026"],
    );
    expect(q).toContain("Verheimlicht vertuscht vergessen 2026");
    expect(q).toContain("Verheimlicht vertuscht vergessen");
    expect(q.every((x) => !/[,„“–]/.test(x))).toBe(true);
  });

  test("sucht eine Gattung vor dem Doppelpunkt nicht allein", () => {
    const q = bookQueries("Kalender: Männer der Waffen‑SS 2026 · ", null, [
      "Kalender: Männer der Waffen‑SS 2026",
    ]);
    expect(q).toEqual(["Kalender Männer der Waffen SS 2026"]);
  });

  test("findet ein Buch, dessen Gattung vor dem Doppelpunkt steht", () => {
    const p = (name: string, url: string) => ({
      name, url, active: true, reference: "", manufacturer: "",
    });
    const kalender = p("Männer der Waffen-SS 2026", "https://lesenundschenken.de/10437-a.html");
    const fremd = p("Kalender Ritterkreuzträger 2026", "https://lesenundschenken.de/10435-b.html");
    expect(chooseBook([fremd, kalender] as any, "Kalender: Männer der Waffen‑SS 2026 · ")).toBe(
      kalender,
    );
  });

  test("stellt die Artikelnummer voran", () => {
    expect(bookQueries("Soldatenköpfe · ", "460721", ["Soldatenköpfe"])[0]).toBe("460721");
  });
});


// Fehler aus der Durchsicht aller Hefte am 29.10.2026
// (tools/buchzuordnung_sim.ts gegen den Stand live).
describe("Buchzuordnung, Durchsicht 29.10.2026", () => {
  let id = 9000;
  const p = (name: string, manufacturer = "", reference = "", nr?: number) => {
    const n = nr ?? ++id;
    return {
      id: n,
      name,
      reference,
      priceCents: 2000,
      url: `https://lesenundschenken.de/${n}-buch.html`,
      coverUrl: null,
      manufacturer,
      active: true,
      digital: null,
    };
  };

  test("'Autor: Titel' im Label: Verfasser vor dem Doppelpunkt", () => {
    expect(splitBookLabel("Manfred Kleine-Hartlage: BRD-Sprech · ")).toEqual({
      title: "BRD-Sprech",
      author: "Manfred Kleine-Hartlage",
    });
    expect(splitBookLabel("Pierre Drieu la Rochelle: Heimat Europa · ").author).toBe(
      "Pierre Drieu la Rochelle",
    );
    // Gattung oder Jahrgang vor dem Doppelpunkt bleiben Teil des Titels.
    expect(splitBookLabel("Kalender: Männer der Waffen‑SS 2026 · ").author).toBe("");
    expect(splitBookLabel("2025: Verheimlicht – vertuscht – vergessen · Gerhard Wisnewski"))
      .toEqual({ title: "2025: Verheimlicht – vertuscht – vergessen", author: "Gerhard Wisnewski" });
    // ZUERST! 6/2025, S. 21: fuehrte auf die Suchseite.
    const brd = p("BRD-Sprech", "Manfred Kleine-Hartlage");
    const sprache = p("Die Sprache der BRD", "Manfred Kleine-Hartlage");
    expect(chooseBook([sprache, brd], "Manfred Kleine-Hartlage: BRD-Sprech · ")?.id).toBe(brd.id);
    expect(bookQueries("Manfred Kleine-Hartlage: BRD-Sprech · ", null, [])).toContain(
      "BRD Sprech Kleine Hartlage",
    );
  });

  test("Artikelnummer zaehlt einmal, auch wenn mehrere Anfragen sie liefern", () => {
    const kalender = p("Wolfgang Willrich: Soldatenköpfe 2026", "", "460721");
    const anderes = p('"Wolfgang Willrich"', "", "460949");
    // Live fuehrte die Flaeche auf "Wolfgang Willrich" (anderes Produkt).
    expect(
      chooseBook([kalender, kalender, anderes], "Wolfgang Willrich: Soldatenköpfe · ", "460721")?.id,
    ).toBe(kalender.id);
    // Mit Nummer nie ein Titeltreffer mit anderer Nummer.
    expect(chooseBook([anderes], "Wolfgang Willrich: Soldatenköpfe · ", "460721")).toBeNull();
  });

  test("Anderer Verfasser im Laden ist ein anderes Buch", () => {
    // 9/2025: "Endspiel" von Werner Reichel fuehrte auf "Endspiel Europa".
    expect(chooseBook([p("Endspiel Europa", "Ulrike Guérot / Hauke Ritz")], "Endspiel · Werner Reichel"))
      .toBeNull();
    expect(
      chooseBook([p("Hybris am Hindukusch", "Michael Lüders")], "Jake Tapper/Alex Thompson: Hybris · "),
    ).toBeNull();
    expect(
      openBookTarget([p("Endspiel Europa", "Ulrike Guérot / Hauke Ritz")], "Endspiel · Werner Reichel"),
    ).toBeUndefined();
  });

  test("Untertitel nach dem Punkt, wenn der Verfasser passt", () => {
    const crash = p("Der Multikulticrash", "Werner Reichel");
    expect(chooseBook([crash], "Endspiel. Der Multikulticrash · Werner Reichel")?.id).toBe(crash.id);
    expect(bookQueries("Endspiel. Der Multikulticrash · Werner Reichel", null, [])).toContain(
      "Der Multikulticrash Reichel",
    );
    // Ein Jahrgang vor dem Titel ist kein Wort, das man weglassen darf.
    const alt = p("Verheimlicht, vertuscht, vergessen", "Gerhard Wisnewski");
    expect(chooseBook([alt], "2025: Verheimlicht – vertuscht – vergessen · Gerhard Wisnewski"))
      .toBeNull();
  });

  test("Dasselbe Buch zweimal im Laden: die neuere Ausgabe", () => {
    const alt = p("Feindliche Übernahme", "Thilo Sarrazin", "", 2043);
    const neu = p("Feindliche Übernahme", "Thilo Sarrazin", "", 9210);
    expect(chooseBook([alt, neu], "Feindliche Übernahme · Thilo Sarrazin")?.id).toBe(9210);
    // Baende einer Reihe mit Herausgeber, Verfasser der Anzeige nicht im Laden: offen.
    const b1 = p("Veteranen der Waffen-SS berichten", "Rolf Michaelis (Hrsg.)");
    const b2 = p("Veteranen der Waffen SS berichten", "Rolf Michaelis (Hrsg.)");
    expect(chooseBook([b1, b2], "Veteranen der Waffen-SS berichten · Erich Thöle/Martin Glade"))
      .toBeNull();
    // Ohne Verfasser in der Anzeige: offen, die Suchseite zeigt beide.
    expect(chooseBook([alt, neu], "Feindliche Übernahme · ")).toBeNull();
    expect(openBookTarget([alt, neu], "Feindliche Übernahme · ")).toBe(
      searchUrl("Feindliche Übernahme"),
    );
  });

  test("Rueckfall auf das Produkt der Anzeige darunter", () => {
    const propaganda = p("Propaganda");
    expect(chooseFromAd([propaganda], "Propaganda oder der Mythos der Demokratie · Gabriele Kuby")?.id)
      .toBe(propaganda.id);
    // Zwei Buecher in der Anzeige: nur das mit passendem Titel.
    const brd = p("BRD-Sprech");
    const sprache = p("Die Sprache der BRD");
    expect(chooseFromAd([brd, sprache], "Die Sprache der BRD · ")?.id).toBe(sprache.id);
    expect(chooseFromAd([], "X · Y")).toBeNull();
  });

  test("Buch nicht im Laden: kein Ziel statt leerer Suchseite", () => {
    expect(openBookTarget([], "Tapetenbewohner · Michael Esders")).toBeUndefined();
    expect(openBookTarget([p("Alliierte Tieffliegerangriffe auf Deutschland")], "Tiefflieger · André Lecloux"))
      .toBeUndefined();
  });

  test("Textflaeche unter einer Buchflaeche", () => {
    const flaeche = { x0: 0.05, y0: 0.08, x1: 0.21, y1: 0.34 };
    expect(textUnderLink({ x0: 0.05, y0: 0.23, x1: 0.21, y1: 0.34 }, flaeche)).toBe(true);
    // Eine Interviewspalte, die nur ein Stueck in die Anzeige ragt.
    expect(
      textUnderLink({ x0: 0.36, y0: 0.06, x1: 0.64, y1: 0.94 }, { x0: 0.37, y0: 0.65, x1: 0.94, y1: 0.94 }),
    ).toBe(false);
  });
});

describe("Offene Buchflaechen", () => {
  test("Rueckfall aus der Anzeige, Suchseite wird erneut versucht, ohne Ziel kein Link", async () => {
    const t = convexTest(schema, modules);
    const { issueId } = await heft(t);
    const ids = await t.run(async (ctx: any) => {
      const now = Date.now();
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: 1,
        title: "Propaganda oder der Mythos der Demokratie",
        source: "idml",
        reviewStatus: "approved",
        primaryPageIndex: 78,
        pageStart: 78,
        pageEnd: 78,
        searchText: "kurz",
        createdAt: now,
        updatedAt: now,
      });
      const blockId = await ctx.db.insert("articleBlocks", {
        articleId,
        issueId,
        order: 1,
        type: "paragraph",
        text: "Gabriele Kuby. Propaganda. 200 S., € 20,–",
      });
      await ctx.db.insert("articleRegions", {
        articleId,
        issueId,
        pageIndex: 78,
        x0: 0.6,
        y0: 0.23,
        x1: 0.77,
        y1: 0.34,
        kind: "body",
      });
      await ctx.db.insert("articleProducts", {
        issueId,
        blockId,
        order: 0,
        source: "title",
        productId: 9192,
      });
      await ctx.db.insert("shopProducts", {
        productId: 9192,
        reference: "282000",
        name: "Propaganda",
        url: "https://lesenundschenken.de/9192-propaganda.html",
        active: true,
        checkedAt: now,
      });
      const box = { pageIndex: 78, x0: 0.6, y0: 0.07, x1: 0.77, y1: 0.34 };
      const suche = await ctx.db.insert("pageLinks", {
        issueId,
        ...box,
        kind: "shop",
        queries: ["Propaganda oder der Mythos der Demokratie"],
        single: true,
        label: "Propaganda oder der Mythos der Demokratie · Gabriele Kuby",
        url: "https://lesenundschenken.de/suche?s=Propaganda",
        source: "import",
      });
      const keins = await ctx.db.insert("pageLinks", {
        issueId,
        ...box,
        pageIndex: 79,
        kind: "shop",
        queries: ["Tapetenbewohner"],
        single: true,
        label: "Tapetenbewohner · Michael Esders",
        resolvedAt: now,
        source: "import",
      });
      const userId = await ctx.db.insert("users", {
        email: "redaktion@example.org",
        roles: ["editor"],
      });
      return { suche, keins, userId };
    });
    const offen = await t.query(internal.pageLinks.listUnresolvedInternal, { issueId });
    const propaganda = offen.find((r: any) => r.id === ids.suche);
    // Die Suchseite gilt als offen; der Rueckfall kennt das Produkt der Anzeige.
    expect(propaganda?.fallback.map((p: any) => p.id)).toEqual([9192]);
    expect(chooseFromAd(propaganda!.fallback, propaganda!.label!)?.id).toBe(9192);
    // Buch nicht im Laden (aufgeloest, ohne Ziel): die Flaeche fuehrt nirgendwohin.
    const redaktion = t.withIdentity({ subject: `${ids.userId}|s` });
    const links = await redaktion.query(api.pageLinks.listForEditors, { issueId });
    expect(links.find((l: any) => l._id === ids.keins)?.target).toBeNull();
    expect(links.find((l: any) => l._id === ids.suche)?.target).toContain("/suche?");
  });
});
