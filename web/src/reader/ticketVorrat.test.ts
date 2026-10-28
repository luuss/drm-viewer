import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketVorrat } from "./schutz";

describe("TicketVorrat", () => {
  afterEach(() => vi.unstubAllGlobals());

  function gateway() {
    let buendel = 0;
    const holen = vi.fn(async () => {
      buendel += 1;
      const t = Array.from({ length: 64 }, (_, i) => `b${buendel}-${i}`);
      return new Response(JSON.stringify({ t }), { status: 200 });
    });
    vi.stubGlobal("fetch", holen);
    return holen;
  }

  it("gibt jedes Ticket einmal aus und holt Buendel nur bei Bedarf", async () => {
    const holen = gateway();
    const vorrat = new TicketVorrat("sitzung", "heft", () => 0);
    const a = await vorrat.ticket();
    const b = await vorrat.ticket();
    expect(a).toBe("b1-0");
    expect(b).toBe("b1-1");
    expect(holen).toHaveBeenCalledTimes(1);
  });

  it("wirft nach einer Lesepause alte Tickets weg, statt 403 zu ernten", async () => {
    gateway();
    let jetzt = 0;
    const vorrat = new TicketVorrat("sitzung", "heft", () => jetzt);
    expect(await vorrat.ticket()).toBe("b1-0");
    // Zehn Minuten Pause: das Gateway nimmt die Tickets nicht mehr.
    jetzt = 10 * 60 * 1000;
    expect(await vorrat.ticket()).toBe("b2-0");
  });

  it("fuellt beim Oeffnen eines Artikels schon vor dem ersten Bild", async () => {
    const holen = gateway();
    const vorrat = new TicketVorrat("sitzung", "heft", () => 0);
    vorrat.vorbereiten();
    expect(holen).toHaveBeenCalledTimes(1);
    expect(await vorrat.ticket()).toBe("b1-0");
    expect(holen).toHaveBeenCalledTimes(1);
  });
});
