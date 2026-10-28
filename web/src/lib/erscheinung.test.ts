import { describe, expect, it } from "vitest";
import { monatJahr, nenntMonat } from "./erscheinung";

const maerz2026 = Date.UTC(2026, 2, 1);
// Als Mitternacht in Berlin gespeichert: in UTC noch der Vortag.
const maerz2026Berlin = Date.UTC(2026, 1, 28, 23, 0);

describe("monatJahr", () => {
  it("zeigt Monat und Jahr statt 01.03.2026", () => {
    expect(monatJahr(maerz2026)).toBe("März 2026");
    expect(monatJahr(maerz2026Berlin)).toBe("März 2026");
    expect(monatJahr(Date.UTC(2025, 3, 1))).toBe("April 2025");
  });
});

describe("nenntMonat", () => {
  it("erkennt den Monat in der Bezeichnung", () => {
    expect(nenntMonat(["März 2026"], maerz2026)).toBe(true);
    expect(nenntMonat(["ZUERST! · März-April 2026"], maerz2026)).toBe(true);
    expect(nenntMonat(["Maerz 2026"], maerz2026)).toBe(true);
    expect(nenntMonat(["ZUERST! 3/2026"], maerz2026)).toBe(true);
    expect(nenntMonat(["Sept./Okt. 2026"], Date.UTC(2026, 8, 1))).toBe(true);
  });

  it("sonst steht das Datum dabei", () => {
    expect(nenntMonat(["Deutsche Militärzeitschrift · 170"], maerz2026)).toBe(false);
    expect(nenntMonat(["März 2025"], maerz2026)).toBe(false);
    expect(nenntMonat(["Nr. 3 · 2026"], maerz2026)).toBe(false);
    expect(nenntMonat(["13/2026"], maerz2026)).toBe(false);
    expect(nenntMonat([null, undefined], maerz2026)).toBe(false);
  });
});
