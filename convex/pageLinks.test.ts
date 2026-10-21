import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  bookQueries,
  chooseBook,
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

