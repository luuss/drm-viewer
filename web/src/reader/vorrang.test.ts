import { describe, expect, it } from "vitest";
import { liveAnfrage, liveLaeuft, NACHLAUF_MS } from "./vorrang";

describe("vorrang", () => {
  it("haelt das Fuellen an, solange die Anzeige holt, und noch kurz danach", async () => {
    let fertig!: () => void;
    const anfrage = liveAnfrage(new Promise<void>((ok) => (fertig = ok)));
    expect(liveLaeuft()).toBe(true);
    fertig();
    await anfrage;
    const ende = Date.now();
    expect(liveLaeuft(ende + NACHLAUF_MS - 10)).toBe(true);
    expect(liveLaeuft(ende + NACHLAUF_MS + 10)).toBe(false);
  });
});
