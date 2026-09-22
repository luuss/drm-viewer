import { describe, expect, it } from "vitest";
import { istTiff, jpegName, zielGroesse } from "./imageConvert";

describe("zielGroesse", () => {
  it("deckelt die laengste Kante und behaelt das Seitenverhaeltnis", () => {
    expect(zielGroesse(4982, 3780, 1600)).toEqual({ width: 1600, height: 1214 });
    expect(zielGroesse(3000, 4525, 1600)).toEqual({ width: 1061, height: 1600 });
  });

  it("vergroessert ein kleines Bild nicht", () => {
    expect(zielGroesse(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("jpegName", () => {
  it("tauscht die Endung", () => {
    expect(jpegName("03 - Greim 1905 - farbig.tif")).toBe(
      "03 - Greim 1905 - farbig.jpg",
    );
    expect(jpegName("ohne-endung")).toBe("ohne-endung.jpg");
  });
});

describe("istTiff", () => {
  it("erkennt beide Endungen, unabhaengig von der Schreibweise", () => {
    expect(istTiff("a.TIF")).toBe(true);
    expect(istTiff("a.tiff")).toBe(true);
    expect(istTiff("a.jpg")).toBe(false);
  });
});

describe("UTIF im Hintergrundfaden", () => {
  it("findet ein window vor", () => {
    // UTIF liest im CMYK-Zweig `window.UDOC`. Fehlt `window` ganz — wie in
    // einem Web Worker —, bricht jede CMYK-TIFF der Druckvorstufe ab.
    expect(typeof (globalThis as Record<string, unknown>).window).not.toBe(
      "undefined",
    );
  });
});
