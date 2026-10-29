import { describe, expect, it } from "vitest";
import { istKennung, istKennungsfehler } from "./kennung";

describe("istKennung", () => {
  it("nimmt echte Kennungen", () => {
    expect(istKennung("jh70gfhsmykjn6x2ygz8qhpe7h8h41p5")).toBe(true);
    expect(istKennung("jh78j21gc2ta3dwd5yb1xxwekx8h41kp")).toBe(true);
  });

  it("weist kaputte Adressen ab, bevor Convex sie sieht", () => {
    expect(istKennung(undefined)).toBe(false);
    expect(istKennung("")).toBe(false);
    expect(istKennung("ungueltig")).toBe(false);
    expect(istKennung("zuerst-4-2025")).toBe(false);
    // Grossbuchstaben und i, l, o, u kommen in Kennungen nicht vor.
    expect(istKennung("JH70GFHSMYKJN6X2YGZ8QHPE7H8H41P5")).toBe(false);
    expect(istKennung("jh70gfhsmykjn6x2ygz8qhpe7h8h41pu")).toBe(false);
    expect(istKennung("jh70gfhsmykjn6x2ygz8qhpe7h8h41p5x")).toBe(true);
    expect(istKennung("jh70gfhsmykjn6x2ygz8qhpe7h8h41")).toBe(false);
  });
});

describe("istKennungsfehler", () => {
  it("erkennt den Fehler einer falschen Kennung", () => {
    expect(
      istKennungsfehler(
        new Error(
          '[CONVEX Q(issues:hasAccess)] ArgumentValidationError: Value does not match validator.',
        ),
      ),
    ).toBe(true);
    expect(istKennungsfehler(new Error("Netzwerkfehler"))).toBe(false);
  });
});
