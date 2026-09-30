import { describe, expect, it } from "vitest";
import { umschlagTafeln } from "./coverPages";

const A4 = { pageWidthPt: 595.276, pageHeightPt: 841.89 };

describe("umschlagTafeln", () => {
  it("nimmt bei zwei Boegen die aeusseren Tafeln: U4|U1 und U2|U3 (DMZ 170)", () => {
    // Bogen 1238 x 889 pt mit 24 pt Anschnitt: Netz 1190 x 841 = zwei Seiten.
    const bogen = {
      breite: 1238.3,
      hoehe: 889.6,
      trim: { links: 24, oben: 24, breite: 1190.3, hoehe: 841.6 },
    };
    const { vorn, hinten } = umschlagTafeln([bogen, bogen], A4);
    expect(vorn.map((t) => [t.printedLabel, t.quellSeite])).toEqual([
      ["U1", 0],
      ["U2", 1],
    ]);
    expect(hinten.map((t) => [t.printedLabel, t.quellSeite])).toEqual([
      ["U3", 1],
      ["U4", 0],
    ]);
    // U1 sitzt rechts auf Bogen 1, U4 links; beide in Netzbreite.
    expect(vorn[0].schnitt.links).toBeCloseTo(24 + 1190.3 - 595.276, 3);
    expect(vorn[0].schnitt.breite).toBeCloseTo(595.276, 3);
    expect(hinten[1].schnitt.links).toBe(24);
    expect(vorn[1].schnitt.links).toBe(24);
    expect(hinten[0].schnitt.links).toBeCloseTo(24 + 1190.3 - 595.276, 3);
  });

  it("laesst bei einem Klappumschlag die Mitte weg (DMZ-Zeitgeschichte 80)", () => {
    // Netz 1786 x 842 = drei Seiten breit.
    const bogen = {
      breite: 1956,
      hoehe: 1012,
      trim: { links: 85, oben: 85, breite: 1786, hoehe: 842 },
    };
    const { vorn, hinten } = umschlagTafeln([bogen, bogen], A4);
    expect(vorn[0].schnitt.links).toBeCloseTo(85 + 1786 - 595.276, 3);
    expect(hinten[1].schnitt.links).toBe(85);
    expect(hinten[1].schnitt.breite).toBeCloseTo(595.276, 3);
    expect(hinten[1].schnitt.hoehe).toBeCloseTo(841.89, 3);
    // In der Hoehe mittig im Netzformat des Bogens.
    expect(hinten[1].schnitt.oben).toBeCloseTo(85 + (842 - 841.89) / 2, 3);
    // Die Klappe zwischen den Tafeln gehoert keiner Seite.
    expect(hinten[1].schnitt.links + hinten[1].schnitt.breite).toBeLessThan(vorn[0].schnitt.links);
  });

  it("halbiert den Bogen, wenn das Netzformat unbekannt ist", () => {
    const bogen = { breite: 1200, hoehe: 850 };
    const { vorn, hinten } = umschlagTafeln([bogen]);
    expect(vorn).toHaveLength(1);
    expect(vorn[0].schnitt).toEqual({ links: 600, oben: 0, breite: 600, hoehe: 850 });
    expect(hinten.map((t) => t.printedLabel)).toEqual(["U4"]);
    expect(hinten[0].schnitt.links).toBe(0);
  });

  it("bringt vier Einzelseiten aus der Bogenreihenfolge in die Lesereihenfolge (ZUERST!)", () => {
    const seite = { breite: 642, hoehe: 889, trim: { links: 24, oben: 24, breite: 595, hoehe: 841 } };
    const { vorn, hinten } = umschlagTafeln([seite, seite, seite, seite], A4);
    expect(vorn.map((t) => [t.printedLabel, t.quellSeite])).toEqual([
      ["U1", 1],
      ["U2", 2],
    ]);
    expect(hinten.map((t) => [t.printedLabel, t.quellSeite])).toEqual([
      ["U3", 3],
      ["U4", 0],
    ]);
    expect(vorn[0].schnitt).toEqual(seite.trim);
  });

  it("kennt Einzelseiten in Lesereihenfolge", () => {
    const seite = { breite: 595, hoehe: 842 };
    expect(umschlagTafeln([seite]).vorn.map((t) => t.printedLabel)).toEqual(["U1"]);
    const zwei = umschlagTafeln([seite, seite]);
    expect(zwei.vorn.map((t) => t.printedLabel)).toEqual(["U1"]);
    expect(zwei.hinten.map((t) => [t.printedLabel, t.quellSeite])).toEqual([["U4", 1]]);
    expect(umschlagTafeln([]).vorn).toEqual([]);
  });
});
