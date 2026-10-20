import { describe, expect, it } from "vitest";
import { ausschnitt, passt, suchwoerter } from "./suche";

describe("suchwoerter", () => {
  it("laesst einzelne Buchstaben aus dem Index", () => {
    expect(suchwoerter("homo-e")).toBe("homo");
    expect(suchwoerter("Plan B")).toBe("plan");
    expect(suchwoerter("e")).toBeNull();
  });
});

describe("passt", () => {
  const text = "Polen muß Homo-Ehen aus anderen Mitgliedstaaten anerkennen";
  it("findet Teile an Wortanfaengen", () => {
    expect(passt(text, "homo")).toBe(true);
    expect(passt(text, "homo-e")).toBe(true);
    expect(passt(text, "Homo-Ehen")).toBe(true);
    expect(passt(text, "polen homo")).toBe(true);
  });
  it("verlangt alle Teile", () => {
    // Frueher reichte ein einzelnes "e" irgendwo im Text.
    expect(passt("Erzgebirge statt Grönland", "homo-e")).toBe(false);
    expect(passt(text, "polen trump")).toBe(false);
  });
  it("nicht mitten im Wort", () => {
    expect(passt(text, "omo")).toBe(false);
  });
  it("Sonderzeichen in der Eingabe sind kein Muster", () => {
    expect(passt("Plan B (2026)", "b (20")).toBe(true);
    expect(passt("Plan B", "b.*")).toBe(false);
  });
});

describe("ausschnitt", () => {
  it("schneidet um die Fundstelle", () => {
    const lang = "x ".repeat(200) + "Homo-Ehen " + "y ".repeat(200);
    const a = ausschnitt(lang, "homo");
    expect(a.startsWith("...")).toBe(true);
    expect(a).toContain("Homo-Ehen");
  });
});
