import { describe, expect, it } from "vitest";
import {
  findeHeftnummer,
  formatHeftnummer,
  gleicheHeftnummer,
  heftnummerProblem,
  heftZeitpunkt,
  monateDerNummer,
  normalisiereHeftnummer,
  zeitraumDerNummer,
} from "./heftnummer";

function nummer(text: string, doppel = false): string | null {
  const fund = findeHeftnummer(text, doppel);
  return fund ? formatHeftnummer(fund.heft) : null;
}

describe("findeHeftnummer: Doppelhefte", () => {
  const faelle: [string, string][] = [
    ["zuerst 8-9-2025", "8-9/2025"],
    ["zuerst 8-9/2025", "8-9/2025"],
    ["zuerst 8/9 2025", "8-9/2025"],
    ["zuerst 8+9 2025", "8-9/2025"],
    ["zuerst 8-9 2025", "8-9/2025"],
    ["zuerst 08 09 2025", "8-9/2025"],
    ["zuerst 7-8-2026", "7-8/2026"],
    ["zuerst 2026-07-08", "7-8/2026"],
    ["Heft 7-8 2026", "7-8/2026"],
    ["zuerst 7 & 8 2026", "7-8/2026"],
    ["dmz 170-171", "170-171"],
    ["dmz 170/171", "170-171"],
  ];
  for (const [text, erwartet] of faelle) {
    it(`"${text}" -> ${erwartet}`, () => expect(nummer(text)).toBe(erwartet));
  }

  it("Doppelausgabe mit nur einem Monat wird zum Doppelheft", () => {
    expect(nummer("zuerst 7/2026", true)).toBe("7-8/2026");
    expect(nummer("zuerst 2026-07", true)).toBe("7-8/2026");
    // Dezember hat keinen Folgemonat im selben Jahr.
    expect(nummer("zuerst 12/2026", true)).toBe("12/2026");
  });
});

describe("findeHeftnummer: Gegenproben", () => {
  const faelle: [string, string | null][] = [
    ["zuerst 3-2026", "3/2026"],
    ["zuerst 3 2026", "3/2026"],
    ["zuerst 2026-03", "3/2026"],
    ["dmz 170", "170"],
    ["DMZ-Zeitgeschichte 80", "80"],
    ["schwerterträger 36 greim", "36"],
    // Seitenbereiche und Daten sind keine Doppelhefte.
    ["dmz 102, s. 11-18, 67-74", "102"],
    ["dmz 101 S. 21-22", "101"],
    ["zuerst 3-2026 stand 28.10.2026", "3/2026"],
    ["zuerst 2026-07-15", null],
    ["seiten 12-15 - 2027", "12"],
    ["sonderheft", null],
  ];
  for (const [text, erwartet] of faelle) {
    it(`"${text}" -> ${erwartet}`, () => expect(nummer(text)).toBe(erwartet));
  }

  it("ein Datum mit Punkten ist keine Heftnummer", () => {
    expect(nummer("Export 28.10.2026")).toBeNull();
    expect(nummer("zuerst 8.9.2025")).toBeNull();
  });

  it("nicht aufeinander folgende Monate sind kein Doppelheft", () => {
    // "3-5 2026" waere ein Seitenbereich vor dem Jahr, kein Heft.
    expect(nummer("zuerst 3-5 2026")).not.toBe("3-5/2026");
  });

  it("meldet ein unmoegliches Jahr statt es zu verschlucken", () => {
    const fund = findeHeftnummer("zuerst 6-6026");
    expect(fund && formatHeftnummer(fund.heft)).toBe("6/6026");
    expect(fund?.problem).toMatch(/6026/);
    expect(findeHeftnummer("zuerst 6-2026")?.problem).toBeUndefined();
  });
});

describe("normalisiereHeftnummer", () => {
  it("bringt Eingaben in die gespeicherte Form", () => {
    expect(normalisiereHeftnummer("8-9/2025")).toBe("8-9/2025");
    expect(normalisiereHeftnummer("08/09 2025")).toBe("8-9/2025");
    expect(normalisiereHeftnummer("8+9-2025")).toBe("8-9/2025");
    expect(normalisiereHeftnummer("Nr. 8-9/2025")).toBe("8-9/2025");
    expect(normalisiereHeftnummer("Doppelausgabe 7/2026")).toBe("7-8/2026");
    expect(normalisiereHeftnummer("03/2026")).toBe("3/2026");
    expect(normalisiereHeftnummer("170")).toBe("170");
    expect(normalisiereHeftnummer("170-171")).toBe("170-171");
  });

  it("laesst Freitext in Ruhe", () => {
    expect(normalisiereHeftnummer("Sonderheft")).toBeNull();
    expect(normalisiereHeftnummer("170 Greim")).toBeNull();
    expect(normalisiereHeftnummer("")).toBeNull();
  });

  it("erkennt dasselbe Heft in anderer Schreibweise", () => {
    expect(gleicheHeftnummer("8-9/2025", "08/09 2025")).toBe(true);
    expect(gleicheHeftnummer("8-9/2025", "9/2025")).toBe(false);
    expect(gleicheHeftnummer("8-9/2025", "8")).toBe(false);
    expect(gleicheHeftnummer("170", "170")).toBe(true);
  });

  it("findet unmoegliche Jahre", () => {
    expect(heftnummerProblem("6/6026")).toMatch(/6026/);
    expect(heftnummerProblem("6/2026")).toBeNull();
    expect(heftnummerProblem("170")).toBeNull();
  });
});

describe("Monate und Ordnung", () => {
  it("liest die Erscheinungsmonate aus der Nummer", () => {
    expect(monateDerNummer("8-9/2025")).toEqual({ von: 8, bis: 9, jahr: 2025 });
    expect(monateDerNummer("3/2026")).toEqual({ von: 3, bis: 3, jahr: 2026 });
    expect(monateDerNummer("170")).toBeNull();
    expect(zeitraumDerNummer("8-9/2025")).toBe("August/September 2025");
    expect(zeitraumDerNummer("7-8/2026")).toBe("Juli/August 2026");
    expect(zeitraumDerNummer("3/2026")).toBe("März 2026");
  });

  it("ordnet ein Doppelheft ohne Datum nach seinem ersten Monat", () => {
    const spaet = Date.UTC(2026, 9, 28);
    const hefte = [
      { n: "10/2025", issueNumber: "10/2025", createdAt: 1 },
      { n: "8-9/2025", issueNumber: "8-9/2025", createdAt: spaet },
      { n: "7/2025", issueNumber: "7/2025", createdAt: 2 },
    ];
    hefte.sort((a, b) => heftZeitpunkt(b) - heftZeitpunkt(a));
    expect(hefte.map((h) => h.n)).toEqual(["10/2025", "8-9/2025", "7/2025"]);
    // Ein gesetztes Datum geht vor.
    expect(heftZeitpunkt({ publicationDate: 5, issueNumber: "8-9/2025", createdAt: 9 })).toBe(5);
  });
});
