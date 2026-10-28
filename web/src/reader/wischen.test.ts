import { describe, expect, it } from "vitest";
import { wischachse, wischziel } from "./wischen";

describe("wischachse", () => {
  it("wartet, bis die Bewegung eine Richtung hat", () => {
    expect(wischachse(4, 3)).toBeNull();
  });

  it("erkennt eine klar seitliche Bewegung in beide Richtungen", () => {
    expect(wischachse(14, 2)).toBe("quer");
    expect(wischachse(-14, 2)).toBe("quer");
  });

  it("laesst schraeges und senkrechtes Ziehen dem Lesetext", () => {
    expect(wischachse(12, 10)).toBe("hoch");
    expect(wischachse(1, -20)).toBe("hoch");
  });
});

describe("wischziel", () => {
  it("nach rechts gewischt geht zum vorigen Artikel, nach links zum naechsten", () => {
    expect(wischziel(120, 10)).toBe("zurueck");
    expect(wischziel(-120, 10)).toBe("weiter");
  });

  it("kurze oder schraege Gesten blaettern nicht", () => {
    expect(wischziel(40, 0)).toBeNull();
    expect(wischziel(100, 90)).toBeNull();
  });
});
