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

  it("nimmt fertig gerenderte Umschlagseiten in Lesereihenfolge", () => {
    const tafel = (label: string, role: any) => ({
      assetId: `t-${label}`,
      previewKey: `k-${label}`,
      width: 2400,
      height: 3394,
      role,
      printedLabel: label,
    });
    const pages = buildPageOrder({
      inner: {
        assetId: "innen",
        pageCount: 2,
        rendered: [
          { assetId: "s1", previewKey: "k1", width: 2400, height: 3394 },
          { assetId: "s2", previewKey: "k2", width: 2400, height: 3394 },
        ],
      },
      coverReading: {
        vorn: [tafel("U1", "front_cover"), tafel("U2", "inside_front")],
        hinten: [tafel("U3", "inside_back"), tafel("U4", "back_cover")],
      },
      // Wird von den fertigen Seiten verdraengt.
      coverImage: { assetId: "titel", previewKey: "kt", width: 1200, height: 1700 },
      printedStart: 3,
    });
    expect(pages.map((p) => [p.printedLabel, p.role, p.sourceAssetId, p.sourcePageIndex])).toEqual([
      ["U1", "front_cover", "t-U1", 0],
      ["U2", "inside_front", "t-U2", 1],
      ["3", "content", "s1", 0],
      ["4", "content", "s2", 1],
      ["U3", "inside_back", "t-U3", 2],
      ["U4", "back_cover", "t-U4", 3],
    ]);
    expect(pages[0].previewKey).toBe("k-U1");
    expect(pages[2].previewKey).toBe("k1");
  });

  it("kommt ohne Umschlag aus", () => {
    const pages = buildPageOrder({ inner: { assetId: "innen", pageCount: 2 }, printedStart: 1 });
    expect(pages.map((p) => p.printedLabel)).toEqual(["1", "2"]);
  });
});
