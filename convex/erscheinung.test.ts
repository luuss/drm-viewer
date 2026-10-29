import { describe, expect, it } from "vitest";
import { erscheinungAusBezeichnung } from "./erscheinung";

describe("erscheinungAusBezeichnung", () => {
  it("liest Monat und Jahr aus den Ladenangaben", () => {
    expect(erscheinungAusBezeichnung("April 2025")).toBe(Date.UTC(2025, 3, 1));
    expect(erscheinungAusBezeichnung("Ausgabe März/April 2026")).toBe(Date.UTC(2026, 2, 1));
    expect(erscheinungAusBezeichnung("Juli–August 2025")).toBe(Date.UTC(2025, 6, 1));
  });

  it("nimmt die erste Angabe, die einen Monat nennt", () => {
    expect(erscheinungAusBezeichnung("DMZ Nr. 170", "Ausgabe März/April 2026")).toBe(
      Date.UTC(2026, 2, 1),
    );
  });

  it("raet nicht", () => {
    expect(erscheinungAusBezeichnung("DMZ Nr. 170", "Schwerterträger Heft 36")).toBeNull();
    expect(erscheinungAusBezeichnung("Ohne Furcht und Tadel", null, undefined)).toBeNull();
    // "Mai" mitten in einem Wort ist kein Monat.
    expect(erscheinungAusBezeichnung("Kaimai 2025")).toBeNull();
  });
});
