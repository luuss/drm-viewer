import { describe, expect, it } from "vitest";
import { wischachse, wischbar, wischziel } from "./wischen";

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

/**
 * Ein Element ohne DOM: `vorfahren` sind die Selektoren, die es selbst oder
 * ein Vorfahr erfuellt; eine Tabelle rollt, wenn `rollt` gesetzt ist.
 */
function element(vorfahren: string[], rollt = false) {
  return {
    closest(selector: string) {
      const passt = selector.split(",").some((s) => vorfahren.includes(s.trim()));
      if (!passt) return null;
      return { scrollWidth: rollt ? 900 : 300, clientWidth: 300 };
    },
  };
}

describe("wischbar", () => {
  it("auf dem Lesetext wird geblaettert", () => {
    expect(wischbar(element([".article-mode"]))).toBe(true);
    expect(wischbar(element([".article-mode", ".article-table"]))).toBe(true);
  });

  it("Regler, Leisten und Verzeichnis ausserhalb des Lesetexts behalten ihre Geste", () => {
    // Der Regler der unteren Leiste: frueher blaetterte ein Zug daran nach
    // dem Sprung noch einen Artikel weiter.
    expect(wischbar(element([".reader-rail", "input"]))).toBe(false);
    expect(wischbar(element([".toc-drawer", "button"]))).toBe(false);
    expect(wischbar(element([".toc-drawer"]))).toBe(false);
    expect(wischbar(element([".reader-bar"]))).toBe(false);
    expect(wischbar(null)).toBe(false);
  });

  it("Bedienelemente im Lesetext und rollende Tabellen sind ausgenommen", () => {
    expect(wischbar(element([".article-mode", "button"]))).toBe(false);
    expect(wischbar(element([".article-mode", "a"]))).toBe(false);
    expect(wischbar(element([".article-mode", ".article-table"], true))).toBe(false);
  });
});
