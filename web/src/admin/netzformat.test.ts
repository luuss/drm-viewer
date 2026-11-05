import { describe, expect, test } from "vitest";
import { netzformatPruefen } from "./netzformat";

// A4 mit gut 10 mm Rand und Marken, wie die Weltkrieg-Druckdaten.
const SEITE = { b: 653.3, h: 899.9 };
const A4 = { breitePt: 595.28, hoehePt: 841.89 };

describe("netzformatPruefen", () => {
  test("TrimBox kleiner als die Seite: gilt", () => {
    expect(netzformatPruefen(SEITE.b, SEITE.h, A4)).toEqual(A4);
  });

  test("schon beschnittenes PDF: nichts zu schneiden", () => {
    expect(netzformatPruefen(595.28, 841.89, A4)).toBeUndefined();
  });

  test("ohne TrimBox oder unplausibel: nicht schneiden", () => {
    expect(netzformatPruefen(SEITE.b, SEITE.h, undefined)).toBeUndefined();
    // Groesser als die Seite.
    expect(netzformatPruefen(500, 700, A4)).toBeUndefined();
    // Schnitte mehr als ein Fuenftel weg (etwa die TrimBox einer anderen Seite).
    expect(netzformatPruefen(1190, 842, A4)).toBeUndefined();
  });
});
