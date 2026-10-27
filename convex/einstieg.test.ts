import { describe, expect, test } from "vitest";
import { absatzBeiPunkt, flussAnteil } from "./einstieg";

const ZWEI_SPALTEN = [
  { x0: 0.05, y0: 0.1, x1: 0.45, y1: 0.9 },
  { x0: 0.55, y0: 0.1, x1: 0.95, y1: 0.9 },
];

describe("Absatz unter dem Tipp", () => {
  test("rechte Spalte oben liegt in der Mitte des Leseflusses", () => {
    expect(flussAnteil(ZWEI_SPALTEN, 0.7, 0.1)).toBeCloseTo(0.5);
    expect(flussAnteil(ZWEI_SPALTEN, 0.2, 0.5)).toBeCloseTo(0.25);
  });

  test("zwei Spalten, vier gleich lange Absaetze", () => {
    const absaetze = [
      { order: 1, text: "a".repeat(100), sourceY: 0.1 },
      { order: 2, text: "b".repeat(100), sourceY: 0.5 },
      { order: 3, text: "c".repeat(100), sourceY: 0.1 },
      { order: 4, text: "d".repeat(100), sourceY: 0.5 },
    ];
    expect(absatzBeiPunkt(absaetze, ZWEI_SPALTEN, 0.2, 0.2)).toBe(1);
    expect(absatzBeiPunkt(absaetze, ZWEI_SPALTEN, 0.2, 0.7)).toBe(2);
    expect(absatzBeiPunkt(absaetze, ZWEI_SPALTEN, 0.7, 0.2)).toBe(3);
    expect(absatzBeiPunkt(absaetze, ZWEI_SPALTEN, 0.7, 0.8)).toBe(4);
  });

  test("ohne Rahmen zaehlt die senkrechte Lage", () => {
    const absaetze = [
      { order: 1, text: "x", sourceY: 0.1 },
      { order: 2, text: "y", sourceY: 0.4 },
      { order: 3, text: "z", sourceY: 0.7 },
    ];
    expect(absatzBeiPunkt(absaetze, [], 0.5, 0.5)).toBe(2);
  });
});
