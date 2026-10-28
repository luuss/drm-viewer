import { describe, expect, it } from "vitest";
import { Warteschlange } from "./bildschlange";

const ruhe = () => new Promise((ok) => setTimeout(ok, 0));

describe("Warteschlange", () => {
  it("laesst nur so viele zugleich laufen, oben im Artikel zuerst", async () => {
    const schlange = new Warteschlange(2);
    const signal = new AbortController().signal;
    const gestartet: number[] = [];
    const freigaben = new Map<number, () => void>();
    for (const rang of [5, 1, 4, 0, 3]) {
      void schlange.platz(rang, signal).then((frei) => {
        gestartet.push(rang);
        freigaben.set(rang, frei);
      });
    }
    await ruhe();
    // Die ersten beiden Anfragen bekommen sofort einen Platz.
    expect(gestartet).toEqual([5, 1]);
    freigaben.get(5)!();
    await ruhe();
    expect(gestartet).toEqual([5, 1, 0]);
    freigaben.get(1)!();
    freigaben.get(0)!();
    await ruhe();
    expect(gestartet).toEqual([5, 1, 0, 3, 4]);
  });

  it("ein Bild, das vor dem Start verschwindet, gibt seinen Platz frei", async () => {
    const schlange = new Warteschlange(1);
    const gestartet: string[] = [];
    let frei: () => void = () => {};
    void schlange.platz(0, new AbortController().signal).then((f) => {
      gestartet.push("a");
      frei = f;
    });
    const weg = new AbortController();
    const abgebrochen = schlange.platz(1, weg.signal).catch(() => "abgebrochen");
    void schlange.platz(2, new AbortController().signal).then(() => gestartet.push("c"));
    await ruhe();
    weg.abort();
    expect(await abgebrochen).toBe("abgebrochen");
    frei();
    frei(); // doppelt freigeben schadet nicht
    await ruhe();
    expect(gestartet).toEqual(["a", "c"]);
  });
});
