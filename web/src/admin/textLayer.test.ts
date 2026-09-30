import { describe, expect, it } from "vitest";
import { normiereTextelemente, textebeneAlsBlob } from "./textLayer";

/** Ungedrehte Seite in Punkt: pdf.js rechnet den Ursprung von unten nach oben. */
function viewport(hoehePt: number) {
  return { convertToViewportPoint: (x: number, y: number) => [x, hoehePt - y] };
}

describe("normiereTextelemente", () => {
  // Druckbogen 637 x 884 pt, Netzformat A4 mittig: 21 pt Anschnitt ringsum.
  const schnitt = { links: 21, oben: 21, breite: 595.276, hoehe: 841.89 };

  it("legt die Grundlinie links als Anker und rechnet auf das Netzformat um", () => {
    const items = [
      // "Inhalt", 16 pt, Grundlinie bei y=819.5 (von unten), x=97.5
      { str: "Inhalt", transform: [16, 0, 0, 16, 97.5, 819.5], width: 29.9, height: 16 },
    ];
    const [eintrag] = normiereTextelemente(items, viewport(883.89), schnitt);
    expect(eintrag[0]).toBe("Inhalt");
    // x0 = (97.5 - 21) / 595.276
    expect(eintrag[1]).toBeCloseTo(0.1285, 4);
    expect(eintrag[3]).toBeCloseTo((97.5 + 29.9 - 21) / 595.276, 4);
    // Oberkante = Grundlinie minus Hoehe, von oben gezaehlt
    const grundlinieVonOben = 883.89 - 819.5;
    expect(eintrag[2]).toBeCloseTo((grundlinieVonOben - 16 - 21) / 841.89, 4);
    expect(eintrag[4]).toBeCloseTo((grundlinieVonOben - 21) / 841.89, 4);
    expect(eintrag[5]).toBe(16);
  });

  it("laesst gedrehten Satz, Leerraum und Stuecke im Anschnitt weg", () => {
    const items = [
      { str: " ", transform: [10, 0, 0, 10, 100, 500], width: 3, height: 10 },
      { str: "Bildnachweis", transform: [0, 8, -8, 0, 630, 500], width: 40, height: 8 },
      // Bogensignatur ganz unten im Anschnitt (Grundlinie 8 pt ueber dem Rand)
      { str: "DMZ 170.indd 4", transform: [6, 0, 0, 6, 30, 8], width: 60, height: 6 },
      { str: "Text", transform: [10, 0, 0, 10, 100, 500], width: 20, height: 10 },
      { type: "beginMarkedContent" },
    ];
    const out = normiereTextelemente(items as any[], viewport(883.89), schnitt);
    expect(out.map((i) => i[0])).toEqual(["Text"]);
  });

  it("schneidet Werte auf die Seite und rundet auf vier Stellen", () => {
    const items = [
      // Ragt links ueber das Netzformat hinaus.
      { str: "Rand", transform: [10, 0, 0, 10, 15, 500], width: 20, height: 10 },
    ];
    const [rand] = normiereTextelemente(items, viewport(883.89), schnitt);
    expect(rand[1]).toBe(0);
    expect(rand[3]).toBe(Math.round(((15 + 20 - 21) / 595.276) * 1e4) / 1e4);
  });
});

describe("textebeneAlsBlob", () => {
  it("schreibt eine JSON-Datei mit Versionsnummer", async () => {
    const blob = textebeneAlsBlob([{ sourcePageIndex: 0, items: [["A", 0, 0, 0.1, 0.1, 9]] }]);
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toEqual({
      version: 1,
      pages: [{ sourcePageIndex: 0, items: [["A", 0, 0, 0.1, 0.1, 9]] }],
    });
  });
});
