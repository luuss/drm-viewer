import { describe, expect, it } from "vitest";
import { ausschnitt, ganzeWoerter, passt, suchwoerter, trefferRang } from "./suche";

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

describe("ganzeWoerter und trefferRang", () => {
  it("Euro ist nicht Europa, Trump nicht Trumpf", () => {
    expect(ganzeWoerter("Der Euro fällt", "euro")).toBe(true);
    expect(ganzeWoerter("Europa wächst", "euro")).toBe(false);
    expect(ganzeWoerter("Sein letzter Trumpf", "Trump")).toBe(false);
    expect(ganzeWoerter("Trump, der Präsident", "trump")).toBe(true);
    expect(ganzeWoerter("Polen und Trump", "trump polen")).toBe(true);
  });
  it("Titel vor Text vor Wortanfang", () => {
    expect(trefferRang("Der Euro wankt", "…", "euro")).toBe(0);
    expect(trefferRang("Schulden", "Der Euro verliert", "euro")).toBe(1);
    expect(trefferRang("Brüssel", "Europa wächst", "euro")).toBe(2);
  });
  it("der Ausschnitt zeigt das ganze Wort, nicht den ersten Wortanfang", () => {
    const text = "Europa " + "x ".repeat(150) + "Der Euro fällt.";
    expect(ausschnitt(text, "euro")).toContain("Der Euro fällt");
  });
});
