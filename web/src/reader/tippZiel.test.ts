import { describe, expect, test } from "vitest";
import { tippZiel, type TippAnzeige, type TippLink, type TippRegion } from "./tippZiel";

const region = (
  articleId: string,
  box: [number, number, number, number],
  kind = "body",
  targetPageIndex: number | null = null,
): TippRegion => ({
  articleId,
  pageIndex: 20,
  x0: box[0],
  y0: box[1],
  x1: box[2],
  y1: box[3],
  kind,
  targetPageIndex,
});
const link = (box: [number, number, number, number], url: string, label: string | null): TippLink => ({
  pageIndex: 20,
  x0: box[0],
  y0: box[1],
  x1: box[2],
  y1: box[3],
  url,
  label,
});
const produkt = (id: number) => ({ productId: id, url: `https://lesenundschenken.de/${id}-buch.html` });
const auf = (x: number, y: number) => ({ pageIndex: 20, x, y });

describe("Tipp auf die Druckseite", () => {
  // ZUERST! 6/2025, S. 21: Interview in drei Spalten, unten rechts die
  // Anzeige mit zwei Buechern; die Umschlaege sind Bilder des Interviews.
  const interview = [
    region("interview", [0.05, 0.06, 0.33, 0.94]),
    region("interview", [0.36, 0.06, 0.64, 0.94]),
    region("interview", [0.67, 0.06, 0.95, 0.94]),
    region("interview", [0.78, 0.65, 0.94, 0.82], "image"),
    region("interview", [0.37, 0.76, 0.51, 0.93], "image"),
  ];
  const anzeige = region("anzeige", [0.37, 0.65, 0.94, 0.94]);
  const anzeigen = new Map<string, TippAnzeige>([
    ["anzeige", { isAd: true, products: [produkt(8997), produkt(10744)] }],
  ]);
  const buchflaeche = link(
    [0.37, 0.65, 0.94, 0.94],
    "https://lesenundschenken.de/8997-brd-sprech.html",
    "BRD-Sprech · Manfred Kleine-Hartlage",
  );

  test("Text der Anzeige oeffnet den Text, ohne Rueckfrage", () => {
    expect(tippZiel(auf(0.6, 0.7), [buchflaeche], [...interview, anzeige], anzeigen)).toEqual({
      art: "artikel",
      articleId: "anzeige",
    });
  });

  test("Umschlag bei zwei Buechern unter einer Flaeche: Auswahl", () => {
    expect(tippZiel(auf(0.85, 0.7), [buchflaeche], [...interview, anzeige], anzeigen)).toEqual({
      art: "auswahl",
      articleId: "anzeige",
    });
  });

  test("Umschlag mit eigener Buchflaeche: direkt das Produkt", () => {
    const eigene = [
      link([0.37, 0.76, 0.51, 0.93], "https://lesenundschenken.de/8997-brd-sprech.html", "BRD-Sprech · "),
      link([0.78, 0.65, 0.94, 0.82], "https://lesenundschenken.de/10744-sprache.html", "Die Sprache der BRD · "),
    ];
    expect(tippZiel(auf(0.85, 0.7), eigene, [...interview, anzeige], anzeigen)).toEqual({
      art: "laden",
      url: "https://lesenundschenken.de/10744-sprache.html",
    });
    expect(tippZiel(auf(0.6, 0.7), eigene, [...interview, anzeige], anzeigen)).toEqual({
      art: "artikel",
      articleId: "anzeige",
    });
  });

  test("Anzeige mit einem Buch: Umschlag fuehrt in den Laden", () => {
    const eins = new Map<string, TippAnzeige>([["anzeige", { isAd: true, products: [produkt(8997)] }]]);
    expect(tippZiel(auf(0.85, 0.7), [], [...interview, anzeige], eins)).toEqual({
      art: "laden",
      url: "https://lesenundschenken.de/8997-buch.html",
    });
  });

  test("Bucherseite: Umschlag in den Laden, Text in den Artikel", () => {
    // Bestand vor dem neuen Import: Flaeche = Umschlag plus Textrahmen.
    const kachel = [
      region("kachel", [0.05, 0.23, 0.21, 0.34]),
      region("kachel", [0.08, 0.08, 0.21, 0.22], "image"),
    ];
    const flaeche = link(
      [0.05, 0.08, 0.21, 0.34],
      "https://lesenundschenken.de/9840-deutschland-schafft-sich-ab.html",
      "Deutschland schafft sich ab · Thilo Sarrazin",
    );
    const ad = new Map<string, TippAnzeige>([["kachel", { isAd: true, products: [produkt(9840)] }]]);
    expect(tippZiel(auf(0.15, 0.15), [flaeche], kachel, ad)).toEqual({
      art: "laden",
      url: flaeche.url,
    });
    expect(tippZiel(auf(0.15, 0.3), [flaeche], kachel, ad)).toEqual({
      art: "artikel",
      articleId: "kachel",
    });
  });

  test("Umschlag in einer Besprechungsspalte: die kleinere Buchflaeche gewinnt", () => {
    const spalte = [region("besprechung", [0.05, 0.05, 0.33, 0.95])];
    const flaeche = link([0.11, 0.07, 0.26, 0.23], "https://lesenundschenken.de/1-x.html", "X · Y");
    expect(tippZiel(auf(0.2, 0.1), [flaeche], spalte, new Map())).toEqual({
      art: "laden",
      url: flaeche.url,
    });
    expect(tippZiel(auf(0.2, 0.5), [flaeche], spalte, new Map())).toEqual({
      art: "artikel",
      articleId: "besprechung",
    });
  });

  test("Abo-Aufruf und Sammelanzeige gehen immer vor", () => {
    const abo = link([0, 0, 1, 1], "https://lesenundschenken.de/abo", null);
    expect(tippZiel(auf(0.5, 0.5), [abo], [region("a", [0, 0, 1, 1])], new Map())).toEqual({
      art: "laden",
      url: abo.url,
    });
  });

  test("Bild eines gewoehnlichen Artikels oeffnet den Artikel", () => {
    expect(tippZiel(auf(0.85, 0.7), [], interview, new Map())).toEqual({
      art: "artikel",
      articleId: "interview",
    });
  });

  test("Verzeichniseintrag springt auf seine Seite", () => {
    const toc = [region("toc", [0.1, 0.1, 0.5, 0.15], "body", 33), region("inhalt", [0, 0, 1, 1])];
    expect(tippZiel(auf(0.2, 0.12), [], toc, new Map())).toEqual({ art: "seite", pageIndex: 33 });
  });

  test("Daneben: nichts", () => {
    expect(tippZiel(auf(0.99, 0.99), [], interview, new Map())).toBeNull();
  });
});
