import { describe, expect, test } from "vitest";
import { istKurz, spaltenZahl, tabellenName, zahlenSpalten, type Tabelle } from "./tabelle";

const greim: Tabelle = {
  headerRows: 1,
  columnWidths: [0.14, 0.22, 0.16, 0.27, 0.22],
  rows: [
    ["Schwerter-Nr.", "Name", "Wehrmachtteil", "Dienstgrad bei Verleihung", "Tag der Verleihung"].map(
      (text) => ({ text, header: true }),
    ),
    ["1", "Erwin Rommel", "Heer", "Oberleutnant", "10. Dezember 1917"].map((text) => ({ text })),
    ["38", "Robert von Greim", "Luftwaffe", "Oberleutnant", "14. Oktober 1918"].map((text) => ({
      text,
      emphasis: true,
    })),
  ],
};

describe("Tabellen im Artikel", () => {
  test("Spaltenzahl kommt aus den Breiten oder der breitesten Zeile", () => {
    expect(spaltenZahl(greim)).toBe(5);
    expect(
      spaltenZahl({ headerRows: 0, rows: [[{ text: "a", colSpan: 3 }], [{ text: "b" }]] }),
    ).toBe(3);
  });

  test("nur reine Zahlenspalten werden mittig gesetzt", () => {
    expect([...zahlenSpalten(greim)]).toEqual([0]);
    const verbunden: Tabelle = {
      headerRows: 0,
      rows: [[{ text: "1", rowSpan: 2 }, { text: "2" }], [{ text: "3" }]],
    };
    expect(zahlenSpalten(verbunden).size).toBe(0);
  });

  test("der Name nennt die Kopfzeile", () => {
    expect(tabellenName(greim)).toBe(
      "Tabelle: Schwerter-Nr., Name, Wehrmachtteil, Dienstgrad bei Verleihung, Tag der Verleihung",
    );
    expect(tabellenName({ headerRows: 0, rows: [[{ text: "x" }]] })).toBe("Tabelle");
  });

  test("kurze Zellen bleiben einzeilig, lange und mehrzeilige nicht", () => {
    expect(istKurz("10. Dezember 1917")).toBe(true);
    expect(istKurz("Treppensturz auf Kreuzfahrtschiff")).toBe(false);
    expect(istKurz("Flandern\nErste Stellung")).toBe(false);
  });
});
