import { describe, expect, it } from "vitest";
import { erscheinungText, monatJahr, nenntMonat, nenntZeitraum } from "./erscheinung";

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
    expect(nenntMonat(["ZUERST! 3/26"], maerz2026)).toBe(true);
    // Fremde Woerter mit Monatsanfang zaehlen nicht.
    expect(nenntMonat(["Mainzer Erklärung 2026"], Date.UTC(2026, 4, 1))).toBe(false);
    expect(nenntMonat(["Augenzeugen berichten 2026"], Date.UTC(2026, 7, 1))).toBe(false);
    expect(nenntMonat(["Ausgabe Sept. 2026"], Date.UTC(2026, 8, 1))).toBe(true);
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

describe("Doppelhefte", () => {
  const aug2025 = Date.UTC(2025, 7, 1);
  const jul2026 = Date.UTC(2026, 6, 1);

  it("zeigen beide Monate", () => {
    expect(erscheinungText(aug2025, "8-9/2025")).toBe("August/September 2025");
    expect(erscheinungText(jul2026, "7-8/2026")).toBe("Juli/August 2026");
    // Als Mitternacht in Berlin gespeichert.
    expect(erscheinungText(Date.UTC(2026, 5, 30, 22, 0), "7-8/2026")).toBe("Juli/August 2026");
  });

  it("Einzelhefte und unpassende Nummern bleiben beim Datum", () => {
    expect(erscheinungText(maerz2026, "3/2026")).toBe("März 2026");
    expect(erscheinungText(maerz2026, "170")).toBe("März 2026");
    expect(erscheinungText(maerz2026, null)).toBe("März 2026");
    // Nummer und Datum widersprechen sich: das Datum gilt.
    expect(erscheinungText(maerz2026, "8-9/2025")).toBe("März 2026");
  });

  it("der Zeitraum steht nur einmal da", () => {
    // Bezeichnung aus dem Laden nennt beide Monate: kein zweites Datum.
    expect(nenntZeitraum(["August/September 2025"], aug2025, "8-9/2025")).toBe(true);
    expect(nenntZeitraum(["Juli/Aug. 2026"], jul2026, "7-8/2026")).toBe(true);
    // Nur die Nummer im Titel: der Zeitraum wird ausgeschrieben.
    expect(nenntZeitraum(["ZUERST! 8-9/2025", "ZUERST! · 8-9/2025"], aug2025, "8-9/2025")).toBe(false);
    // Nur ein Monat genannt: der ganze Zeitraum kommt dazu.
    expect(nenntZeitraum(["August 2025"], aug2025, "8-9/2025")).toBe(false);
    // Einzelheft wie bisher.
    expect(nenntZeitraum(["ZUERST! 3/2026"], maerz2026, "3/2026")).toBe(true);
  });
});
