import { describe, expect, it } from "vitest";
import { umschlagTafeln, tafelnNachInhalt, titelseitenWert } from "./coverPages";

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

describe("tafelnNachInhalt", () => {
  const schnitt = { links: 0, oben: 0, breite: 400, hoehe: 560 };
  const t = (role: any, printedLabel: any, quellSeite: number) => ({ role, printedLabel, quellSeite, schnitt });
  const titel = [
    ["WELTKRIEG", 0.05, 0.01, 0.9, 0.17, 100],
    ["NR. 112", 0.05, 0.18, 0.15, 0.2, 16],
    ["€ 3,95", 0.85, 0.18, 0.94, 0.2, 16],
    ["WWW.WELTKRIEG.INFO", 0.35, 0.18, 0.65, 0.2, 16],
  ] as const;
  const anzeige = [
    ["FREIKORPS", 0.05, 0.02, 0.9, 0.15, 70],
    ["Aktuell ist Heft Nr. 35", 0.1, 0.9, 0.5, 0.92, 9],
    ["€ 2,95", 0.1, 0.93, 0.2, 0.95, 9],
    ["www.freikorps.info", 0.1, 0.96, 0.4, 0.98, 9],
  ] as const;
  // "Zwei Treffer": die PDF-Folge war U2, U3, U4, U1; geometrisch geraten
  // wurde U4, U1, U2, U3.
  const geraten = {
    vorn: [t("front_cover", "U1", 1), t("inside_front", "U2", 2)],
    hinten: [t("inside_back", "U3", 3), t("back_cover", "U4", 0)],
  };
  it("nimmt die Tafel mit der eigenen Nummer als Titelseite, ihre Bogenpartnerin als U4", () => {
    const texte = new Map<any, any>([
      [geraten.hinten[0], titel],
      [geraten.vorn[1], anzeige],
    ]);
    const neu = tafelnNachInhalt(geraten, texte, "112");
    const lage = [...neu.vorn, ...neu.hinten].map((x) => `${x.printedLabel}:${x.quellSeite}`);
    expect(lage).toEqual(["U1:3", "U2:0", "U3:1", "U4:2"]);
  });
  it("laesst die Lage, wenn keine Tafel eindeutig Titelseite ist", () => {
    const texte = new Map<any, any>([[geraten.vorn[1], anzeige]]);
    expect(tafelnNachInhalt(geraten, texte, "112")).toBe(geraten);
  });
  it("erkennt fremde Hefte in Anzeigen nicht als Titelseite", () => {
    expect(titelseitenWert(anzeige, "112")).toBeLessThan(titelseitenWert(titel, "112"));
  });
  it("nimmt ohne eigene Nummer die klar beste Tafel, wenn U1 gar nicht passt", () => {
    // "b1 Tanks forward": Ordner b1, Umschlag "No. 35"; U1 war eine Fahrzeugtafel.
    const blitz = [
      ["BLITZKRIEG", 0.05, 0.03, 0.9, 0.15, 90],
      ["NO. 35", 0.05, 0.16, 0.15, 0.18, 14],
      ["€ 4,95", 0.85, 0.16, 0.94, 0.18, 14],
    ] as const;
    const texte = new Map<any, any>([[geraten.vorn[1], blitz]]);
    const neu = tafelnNachInhalt(geraten, texte, "1");
    expect(neu.vorn[0].quellSeite).toBe(2);
  });
});

