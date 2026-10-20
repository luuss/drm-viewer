import { describe, expect, it } from "vitest";
import { meldungsfolge } from "./meldungsfolge";

const zeile = (order: number, y: number) => ({ order, y, block: { type: "subheading" } });
const text = (order: number, y: number) => ({ order, y, block: { type: "paragraph" } });
const bild = (name: string, y: number) => ({ name, y });

describe("meldungsfolge", () => {
  // DMZ 170, S. 51 "Nachrichten aus aller Welt", Lagen wie im Bestand.
  const bloecke = [
    zeile(1, 0.084), text(2, 0.178),
    zeile(3, 0.305), text(4, 0.408),
    zeile(5, 0.497), text(6, 0.606),
    zeile(7, 0.733), text(8, 0.836),
  ];

  it("haengt jedes Bild hinter die Zeile seiner Meldung", () => {
    const bilder = [bild("Zerstörer", 0.515), bild("CV90", 0.077), bild("Manila", 0.765), bild("AWACS", 0.3)];
    const folge = meldungsfolge(bloecke, bilder)!;
    const namen = folge.map((x) => ("name" in x ? x.name : x.order));
    expect(namen).toEqual([1, "CV90", 2, 3, "AWACS", 4, 5, "Zerstörer", 6, 7, "Manila", 8]);
  });

  it("laesst lange Artikel mit Zwischentiteln in Ruhe", () => {
    expect(meldungsfolge([text(1, 0.05), zeile(2, 0.3), text(3, 0.35), zeile(4, 0.6)], [bild("x", 0.4)])).toBeNull();
  });

  it("gibt auf, wenn zwei Spalten auf gleicher Hoehe in Frage kommen", () => {
    const zweiSpalten = [zeile(1, 0.1), text(2, 0.15), zeile(3, 0.5), text(4, 0.55), zeile(5, 0.1), text(6, 0.15)];
    expect(meldungsfolge(zweiSpalten, [bild("x", 0.12)])).toBeNull();
  });
});
