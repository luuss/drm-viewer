import { afterEach, describe, expect, it, vi } from "vitest";
import { mitWiederholung, nochmalNach } from "./nachladen";

describe("nochmalNach", () => {
  it("wartet nach 429 so lange, wie das Gateway sagt, in Grenzen", () => {
    expect(nochmalNach(429, 0, "3")).toBe(3000);
    expect(nochmalNach(429, 0, "0")).toBe(1000);
    expect(nochmalNach(429, 0, "55")).toBe(8000);
  });

  it("wird ohne Retry-After von Mal zu Mal geduldiger", () => {
    const pausen = [0, 1, 2, 3, 8].map((v) => nochmalNach(429, v));
    expect(pausen[0]).toBe(1000);
    expect(pausen[1]).toBeGreaterThan(pausen[0]!);
    expect(pausen[4]).toBe(8000);
  });

  it("gibt nach gut einer Minute Bremse auf", () => {
    expect(nochmalNach(429, 11)).not.toBeNull();
    expect(nochmalNach(429, 12)).toBeNull();
  });

  it("versucht Netz- und Serverfehler genau einmal neu", () => {
    expect(nochmalNach("netz", 0)).toBe(1000);
    expect(nochmalNach(521, 0)).toBe(1000);
    expect(nochmalNach(521, 1)).toBeNull();
    expect(nochmalNach("netz", 1)).toBeNull();
  });

  it("wiederholt keine endgueltigen Antworten", () => {
    expect(nochmalNach(409, 0)).toBeNull();
    expect(nochmalNach(403, 0)).toBeNull();
  });
});

describe("mitWiederholung", () => {
  afterEach(() => vi.useRealTimers());

  it("laedt nach einem 429 von selbst noch einmal", async () => {
    vi.useFakeTimers();
    const antworten = [
      new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      new Response("ok", { status: 200 }),
    ];
    const hole = vi.fn(async () => antworten.shift()!);
    const gemeldet: unknown[] = [];
    const laeuft = mitWiederholung(hole, new AbortController().signal, (a) => gemeldet.push(a));
    await vi.advanceTimersByTimeAsync(2000);
    const res = await laeuft;
    expect(res.status).toBe(200);
    expect(hole).toHaveBeenCalledTimes(2);
    expect(gemeldet).toEqual([429]);
  });

  it("gibt nach dem zweiten Netzfehler den Fehler weiter", async () => {
    vi.useFakeTimers();
    const hole = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const laeuft = mitWiederholung(hole, new AbortController().signal);
    const ergebnis = expect(laeuft).rejects.toThrow("Failed to fetch");
    await vi.advanceTimersByTimeAsync(1000);
    await ergebnis;
    expect(hole).toHaveBeenCalledTimes(2);
  });

  it("liefert die letzte Antwort, wenn ein zweiter Versuch nicht hilft", async () => {
    vi.useFakeTimers();
    const hole = vi.fn(async () => new Response("", { status: 521 }));
    const laeuft = mitWiederholung(hole, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await laeuft).status).toBe(521);
    expect(hole).toHaveBeenCalledTimes(2);
  });

  it("hoert beim Weiterblaettern sofort auf zu warten", async () => {
    vi.useFakeTimers();
    const abbruch = new AbortController();
    const hole = vi.fn(async () => new Response("", { status: 429 }));
    const laeuft = mitWiederholung(hole, abbruch.signal);
    const ergebnis = expect(laeuft).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(10);
    abbruch.abort();
    await ergebnis;
    expect(hole).toHaveBeenCalledTimes(1);
  });
});
