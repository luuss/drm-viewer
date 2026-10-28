import { describe, expect, it } from "vitest";
import { bildfolge } from "./bildfolge";

const absatz = (order: number, page: number, y: number) => ({
  order, page, y, block: { type: "paragraph" },
});
const zwischentitel = (order: number, page: number, y: number) => ({
  order, page, y, block: { type: "subheading" },
});
const bild = (name: string, page: number, y: number) => ({ name, page, y });
const folge = (items: ({ order: number } | { name: string })[]) =>
  items.map((x) => ("name" in x ? x.name : x.order));

describe("bildfolge", () => {
  it("verteilt die Bilder einer Seite zwischen ihre Absaetze", () => {
    // ZUERST!: Aufmacherbild ueber dem Text, drei Bilder darunter; vorher
    // standen alle drei hinter dem letzten Absatz.
    const bloecke = Array.from({ length: 12 }, (_, i) => absatz(i + 1, 4, 0.2 + i * 0.05));
    const bilder = [bild("c", 4, 0.8), bild("auf", 4, 0.05), bild("a", 4, 0.3), bild("b", 4, 0.5)];
    expect(folge(bildfolge(bloecke, bilder))).toEqual([
      "auf", 1, 2, 3, "a", 4, 5, 6, "b", 7, 8, 9, "c", 10, 11, 12,
    ]);
  });

  it("laesst zwischen zwei Bildern mindestens einen Absatz", () => {
    // Drei Bilder auf einer Seite mit zwei Absaetzen: das dritte rueckt in den
    // Text der naechsten Seite.
    const bloecke = [absatz(1, 2, 0.1), absatz(2, 2, 0.5), absatz(3, 3, 0.1), absatz(4, 3, 0.5)];
    const bilder = [bild("a", 2, 0.3), bild("b", 2, 0.6), bild("c", 2, 0.9)];
    expect(folge(bildfolge(bloecke, bilder))).toEqual([1, "a", 2, "b", 3, "c", 4]);
  });

  it("stellt kein Bild zwischen Zwischentitel und Text", () => {
    const bloecke = [absatz(1, 5, 0.1), zwischentitel(2, 5, 0.4), absatz(3, 5, 0.45)];
    expect(folge(bildfolge(bloecke, [bild("a", 5, 0.5)]))).toEqual([1, "a", 2, 3]);
  });

  it("ein Bild ueber dem Text der Folgeseite steht vor ihm", () => {
    const bloecke = [absatz(1, 6, 0.1), absatz(2, 6, 0.5), absatz(3, 7, 0.4), absatz(4, 7, 0.7)];
    expect(folge(bildfolge(bloecke, [bild("a", 7, 0.05)]))).toEqual([1, 2, "a", 3, 4]);
  });

  it("rueckt Bilder nur zusammen, wenn die Absaetze nicht reichen", () => {
    const bloecke = [absatz(1, 8, 0.1)];
    const bilder = [bild("a", 8, 0.3), bild("b", 8, 0.5), bild("c", 8, 0.7)];
    expect(folge(bildfolge(bloecke, bilder))).toEqual(["a", "b", 1, "c"]);
    expect(folge(bildfolge([], bilder))).toEqual(["a", "b", "c"]);
  });
});
