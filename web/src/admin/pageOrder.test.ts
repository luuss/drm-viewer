import { describe, expect, it } from "vitest";
import { buildPageOrder, resolveLayout } from "./pageOrder";

describe("resolveLayout", () => {
  it("erkennt Doppelseiten und Einzelseiten an der Seitenzahl", () => {
    expect(resolveLayout("auto", 2)).toBe("spreads");
    expect(resolveLayout("auto", 4)).toBe("sheets");
    expect(resolveLayout("auto", 1)).toBe("reading");
    expect(resolveLayout("sheets", 2)).toBe("sheets");
  });
});

describe("buildPageOrder", () => {
  it("setzt die Titelseite als Bild vor den Innenteil", () => {
    const pages = buildPageOrder({
      inner: { assetId: "innen", pageCount: 3 },
      coverImageAssetId: "titel",
      printedStart: 3,
    });
    expect(pages).toEqual([
      { sourceAssetId: "titel", sourcePageIndex: 0, role: "front_cover", printedLabel: "U1" },
      { sourceAssetId: "innen", sourcePageIndex: 0, role: "content", printedLabel: "3" },
      { sourceAssetId: "innen", sourcePageIndex: 1, role: "content", printedLabel: "4" },
      { sourceAssetId: "innen", sourcePageIndex: 2, role: "content", printedLabel: "5" },
    ]);
  });

  it("zerlegt zwei Umschlagboegen in vier Leserseiten", () => {
    const pages = buildPageOrder({
      inner: { assetId: "innen", pageCount: 1 },
      cover: { assetId: "u", pageCount: 2 },
    });
    expect(pages.map((p) => [p.printedLabel, p.sourcePageIndex, p.sourceHalf])).toEqual([
      ["U1", 0, "right"],
      ["U2", 1, "left"],
      ["3", 0, undefined],
      ["U3", 1, "right"],
      ["U4", 0, "left"],
    ]);
  });

  it("bringt vier Einzelseiten aus der Bogenreihenfolge in die Lesereihenfolge", () => {
    const pages = buildPageOrder({
      inner: { assetId: "innen", pageCount: 1 },
      cover: { assetId: "u", pageCount: 4 },
    });
    expect(pages.map((p) => [p.printedLabel, p.sourcePageIndex])).toEqual([
      ["U1", 1],
      ["U2", 2],
      ["3", 0],
      ["U3", 3],
      ["U4", 0],
    ]);
  });

  it("kommt ohne Umschlag aus", () => {
    const pages = buildPageOrder({ inner: { assetId: "innen", pageCount: 2 }, printedStart: 1 });
    expect(pages.map((p) => p.printedLabel)).toEqual(["1", "2"]);
  });
});
