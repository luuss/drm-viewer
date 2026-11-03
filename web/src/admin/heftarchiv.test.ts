import { describe, expect, it } from "vitest";
import { heftKennung, hefteImArchiv } from "./heftarchiv";

const f = (path: string) => ({ path, name: path.split("/").pop()!, size: 1, file: new Blob() as File });

describe("heftKennung", () => {
  it("liest Nummer und Buchstaben", () => {
    expect(heftKennung("121d Durchbruch Krim")).toBe("121d");
    expect(heftKennung("23 Fk Kärnten")).toBe("23fk");
    expect(heftKennung("b1 tanks forward")).toBe("b1");
    expect(heftKennung("Ausgabe")).toBeNull();
  });
});

describe("hefteImArchiv", () => {
  const archiv = [
    f("wk/Doppelbände/121-130d/121d Durchbruch Krim/121d Innenteil.indd"),
    f("wk/Doppelbände/121-130d/121d Durchbruch Krim/Ausgabe/121d Innenteil Krim/121d Innenteil Krim.pdf"),
    f("wk/Doppelbände/121-130d/121d Durchbruch Krim/Ausgabe/121d Umschlag Krim.pdf"),
    f("wk/Doppelbände/121-130d/121d Durchbruch Krim/Links/foto.tif"),
    // dasselbe Heft im E-Book-Ordner, mit IDML: diese Fassung gewinnt
    f("wk/E-Books/121d durchbruch/121d innenteil, durchbruch/121d durchbruch 2026.idml"),
    f("wk/E-Books/121d durchbruch/121d innenteil, durchbruch/121d durchbruch 2026.pdf"),
    f("wk/E-Books/121d durchbruch/121d umschlag, durchbruch/121d umschlag 2026.pdf"),
    // Heft nur mit INDD: kein Import
    f("wk/Doppelbände/151-160/151d Normandie/151d Innenteil Der erste Tag.indd"),
    // alter Stand bleibt draussen
    f("wk/E-Books/ALT-ALT/9n alt/9n Innenteil.pdf"),
    f("wk/Normalhefte/9n Kessel/Ausgabe/9n Innenteil Kessel.pdf"),
  ];
  const hefte = hefteImArchiv(archiv);
  it("findet jedes Heft einmal, die Fassung mit IDML zuerst", () => {
    expect(hefte.map((h) => [h.kennung, h.mitIdml])).toEqual([
      ["9n", false],
      ["121d", true],
    ]);
    expect(hefte[1].pfad).toBe("wk/E-Books/121d durchbruch");
  });
  it("nimmt Unterordner mit und laesst alte Staende weg", () => {
    expect(hefte[0].pfad).toBe("wk/Normalhefte/9n Kessel");
    expect(hefte[0].files.map((x) => x.path)).toEqual(["Ausgabe/9n Innenteil Kessel.pdf"]);
    expect(hefte[1].files.map((x) => x.path).sort()).toEqual([
      "121d innenteil, durchbruch/121d durchbruch 2026.idml",
      "121d innenteil, durchbruch/121d durchbruch 2026.pdf",
      "121d umschlag, durchbruch/121d umschlag 2026.pdf",
    ]);
  });
});
