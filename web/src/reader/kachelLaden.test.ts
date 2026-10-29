import { describe, expect, it, vi } from "vitest";
import { kachelLader, type KachelAuftrag } from "./kachelLaden";

const ruhe = () => new Promise((ok) => setTimeout(ok, 0));

function auftrag(src = "/page/3/tile/0/0/0.jpg") {
  const a: KachelAuftrag & { ergebnis: string[] } = {
    src,
    userData: {},
    jobId: 1,
    ergebnis: [],
    finish: (daten) => {
      a.ergebnis.push(`finish:${String(daten)}`);
      a.jobId = null;
    },
    fail: (fehler) => {
      a.ergebnis.push(`fail:${fehler}`);
      a.jobId = null;
    },
  };
  return a;
}

/** Holt erst, wenn der Test es sagt; merkt sich das Signal jeder Kette. */
function steuerbar() {
  const ketten: { signal: AbortSignal; aktuell: () => boolean; fertig: (d: string) => void; fehler: (e: string) => void }[] = [];
  const holen = vi.fn(
    (_src: string, signal: AbortSignal, aktuell: () => boolean) =>
      new Promise<unknown>((fertig, fehler) => ketten.push({ signal, aktuell, fertig, fehler })),
  );
  return { holen, ketten };
}

describe("kachelLader", () => {
  it("liefert die Kachel an den laufenden Auftrag", async () => {
    const { holen, ketten } = steuerbar();
    const lader = kachelLader(holen);
    const a = auftrag();
    lader.start(a);
    ketten[0].fertig("bild");
    await ruhe();
    expect(a.ergebnis).toEqual(["finish:bild"]);
    expect(lader.anzahl).toBe(0);
  });

  it("ein Neuversuch derselben Kachel bricht die alte Kette ab, ihr spaetes fail stoert nicht", async () => {
    const { holen, ketten } = steuerbar();
    const lader = kachelLader(holen);
    const a = auftrag();
    lader.start(a);
    // OpenSeadragon: Zeitlimit -> fail(), dann derselbe Auftrag noch einmal.
    a.fail("Zeitlimit", null);
    a.jobId = 2;
    lader.start(a);
    expect(ketten[0].signal.aborted).toBe(true);
    expect(ketten[0].aktuell()).toBe(false);
    ketten[0].fehler("Kachel 429");
    await ruhe();
    ketten[1].fertig("bild");
    await ruhe();
    expect(a.ergebnis).toEqual(["fail:Zeitlimit", "finish:bild"]);
  });

  it("nach dem Zeitlimit ohne Neuversuch laeuft die Kette nicht weiter", async () => {
    const { holen, ketten } = steuerbar();
    const lader = kachelLader(holen);
    const a = auftrag();
    lader.start(a);
    a.fail("Zeitlimit", null);
    expect(ketten[0].aktuell()).toBe(false);
    ketten[0].fertig("zu spaet");
    await ruhe();
    expect(a.ergebnis).toEqual(["fail:Zeitlimit"]);
  });

  it("Blaettern bricht alle Ketten der Seite ab, ohne finish oder fail", async () => {
    const { holen, ketten } = steuerbar();
    const lader = kachelLader(holen);
    const a = auftrag("/page/3/tile/0/0/0.jpg");
    const b = auftrag("/page/4/tile/0/1/0.jpg");
    lader.start(a);
    lader.start(b);
    lader.alleAbbrechen();
    expect(ketten.every((k) => k.signal.aborted)).toBe(true);
    ketten[0].fehler("AbortError");
    ketten[1].fertig("zu spaet");
    await ruhe();
    expect(a.ergebnis).toEqual([]);
    expect(b.ergebnis).toEqual([]);
    expect(lader.anzahl).toBe(0);
    // Der Neuversuch von OpenSeadragon nach dem Zeitlimit holt nichts mehr.
    a.jobId = 3;
    lader.start(a);
    expect(holen).toHaveBeenCalledTimes(2);
    expect(a.ergebnis).toEqual(["fail:Seite geschlossen"]);
  });

  it("ein neuer Auftrag fuer dieselbe Kachel ersetzt den alten", async () => {
    const { holen, ketten } = steuerbar();
    const lader = kachelLader(holen);
    const alt = auftrag();
    const neu = auftrag();
    lader.start(alt);
    lader.start(neu);
    expect(ketten[0].signal.aborted).toBe(true);
    ketten[1].fertig("bild");
    await ruhe();
    expect(neu.ergebnis).toEqual(["finish:bild"]);
  });
});
