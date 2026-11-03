import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { fuellen, kachelPlan, naechsteSeite, type Fuellauftrag } from "./pufferFuellen";
import { paketFuer, pufferAblageSetzen, satzVon, SpeicherAblage } from "./puffer";
import type { Id } from "../lib/api";

describe("kachelPlan", () => {
  it("nimmt von grob nach fein alle Stufen bis 1, nicht die volle Aufloesung", () => {
    // Ein Seitenbild aus dem Import: 2400 x 3300, Kacheln zu 512.
    const plan = kachelPlan({ width: 2400, height: 3300, tileSize: 512, maxLevel: 3 });
    const jeStufe = new Map<number, number>();
    for (const [stufe] of plan) jeStufe.set(stufe, (jeStufe.get(stufe) ?? 0) + 1);
    expect([...jeStufe.entries()]).toEqual([
      [3, 1],
      [2, 4],
      [1, 12],
    ]);
    expect(plan[0][0]).toBe(3);
  });

  it("hat bei einer kleinen Seite nur ihre eine Stufe", () => {
    expect(kachelPlan({ width: 400, height: 500, tileSize: 512, maxLevel: 0 })).toEqual([[0, 0, 0]]);
  });
});

describe("naechsteSeite", () => {
  it("faengt an der aufgeschlagenen Seite an und geht am Ende vorne weiter", () => {
    const offen = new Set([0, 1, 2, 3, 4]);
    const folge: number[] = [];
    while (offen.size) {
      const p = naechsteSeite(offen, 3, 5);
      offen.delete(p);
      folge.push(p);
    }
    expect(folge).toEqual([3, 4, 0, 1, 2]);
  });
});

const HEFT = "heft1" as Id<"issues">;
const BILD = "j57abcdefghjkmnpqrstvwxyz0123456";

/** Gateway und Convex zum Nachspielen: zaehlt, was geholt wird. */
function anlage() {
  const geholt: string[] = [];
  const ohneTicket: string[] = [];
  // Ohne den Kopf des Puffers: haette das Gateway vor die Anzeige gestellt.
  const vorn: string[] = [];
  let buendel = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const kopf = new Headers(init?.headers);
      if (url.endsWith(`/api/issue/${HEFT}/n`)) {
        buendel += 1;
        const t = Array.from({ length: 64 }, (_, i) => `t${buendel}-${i}`);
        return new Response(JSON.stringify({ t }));
      }
      geholt.push(url);
      if (/\/tile\/|\/api\/asset\//.test(url) && !kopf.get("X-Req")) ohneTicket.push(url);
      if (kopf.get("X-Q") !== "1" && !url.includes("/f/")) vorn.push(url);
      if (url.endsWith("/info")) {
        return new Response(JSON.stringify({ width: 1000, height: 1400, tileSize: 512, maxLevel: 2 }));
      }
      if (url.includes("/f/")) return new Response(`SCHRIFT ${url} ${kopf.get("X-Tile-Session")}`);
      if (url.includes("/api/asset/")) return new Response(`BILD ${url}`, { headers: { "X-V": "1" } });
      return new Response(`KACHEL ${url}`);
    }),
  );
  const texte: Array<{ sessionToken: string }> = [];
  const convex = {
    query: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
      switch (getFunctionName(ref as never)) {
        case "issues:getPublic":
          return { _id: HEFT, title: "Testheft", owned: true };
        case "issuePages:listForReader":
          return [
            { index: 0, printedLabel: "U1", role: "cover", width: 1000, height: 1400, stand: "a" },
            { index: 1, printedLabel: "2", role: "content", width: 1000, height: 1400, stand: "b" },
          ];
        case "articles:listForReader":
          return [{ _id: "art1", pageStart: 1, pageEnd: 1 }];
        case "articles:getForReader":
          texte.push(args as { sessionToken: string });
          return {
            _id: "art1",
            issueId: HEFT,
            pageStart: 1,
            pageEnd: 1,
            title: `verschluesselt fuer ${args.sessionToken}`,
            blocks: [],
            images: [{ url: `http://localhost:8000/api/asset/${BILD}.jpg`, page: 1, stand: "x" }],
          };
        default:
          return [];
      }
    }),
  };
  return { geholt, ohneTicket, vorn, convex, texte };
}

function auftrag(convex: unknown, sessionToken: string, k: number): Fuellauftrag {
  return {
    issueId: HEFT,
    userId: "leser-1",
    sessionToken,
    k,
    watermark: "leser@example.org",
    convex: convex as Fuellauftrag["convex"],
    position: () => 1,
  };
}

describe("fuellen", () => {
  let ablage: SpeicherAblage;
  beforeEach(() => {
    ablage = new SpeicherAblage();
    pufferAblageSetzen(ablage);
  });
  afterEach(() => {
    pufferAblageSetzen(null);
    vi.unstubAllGlobals();
  });

  it("legt die ganze Ausgabe ab: Listen, Schriften, Texte, Seiten, Kacheln, Bilder", async () => {
    const { geholt, ohneTicket, vorn, convex } = anlage();
    const token = "s".repeat(64);
    await fuellen(auftrag(convex, token, 4711), new AbortController().signal);

    const paket = (await paketFuer(HEFT, "leser-1"))!;
    expect(paket.kopf.fertig).toBe(true);
    expect(paket.daten?.issue.title).toBe("Testheft");
    const satz = satzVon(token);
    expect((await paket.artikel("art1"))?.satz).toBe(satz);
    for (const nr of [0, 1, 2]) expect(await paket.schrift(satz, nr)).not.toBeNull();
    for (const [seite, stand] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      expect(await paket.seitenInfo(seite, stand)).toMatchObject({ maxLevel: 2 });
      // Stufe 2: 250 x 350 (eine Kachel), Stufe 1: 500 x 700 (zwei).
      for (const [l, c, r] of [
        [2, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
      ]) {
        const kachel = await paket.kachel(seite, stand, l, c, r);
        expect(kachel?.k).toBe(4711);
      }
      expect(await paket.kachel(seite, stand, 0, 0, 0)).toBeNull();
    }
    const bild = await paket.bild(BILD, "x");
    expect(bild).toMatchObject({ k: 4711, verwuerfelt: true });
    // Kacheln und Bilder nur mit Einmal-Ticket, die aufgeschlagene Seite zuerst.
    expect(ohneTicket).toEqual([]);
    expect(vorn).toEqual([]);
    expect(geholt.find((u) => u.includes("/page/"))).toContain("/page/1/");
  });

  it("baut bei einer neuen Sitzung auf dem Paket auf: nur die Texte kommen neu", async () => {
    const { geholt, convex, texte } = anlage();
    const erste = "e".repeat(64);
    const zweite = "z".repeat(64);
    await fuellen(auftrag(convex, erste, 1), new AbortController().signal);
    const vorher = geholt.length;
    await fuellen(auftrag(convex, zweite, 2), new AbortController().signal);
    const neu = geholt.slice(vorher);

    expect(neu.filter((u) => /\/tile\/|\/info$|\/api\/asset\//.test(u))).toEqual([]);
    expect(neu.filter((u) => u.includes("/f/"))).toHaveLength(3);
    expect(texte.map((t) => t.sessionToken)).toEqual([erste, zweite]);

    const paket = (await paketFuer(HEFT, "leser-1"))!;
    expect((await paket.artikel("art1"))?.satz).toBe(satzVon(zweite));
    // Kacheln behalten den Schluessel ihrer Sitzung.
    expect((await paket.kachel(1, "b", 1, 0, 0))?.k).toBe(1);
    // Die Schrift der alten Sitzung braucht kein Text mehr.
    expect(await paket.schrift(satzVon(erste), 0)).toBeNull();
    expect(await paket.schrift(satzVon(zweite), 0)).not.toBeNull();
  });

  it("faengt von vorn an, wenn die Seiten neu importiert wurden", async () => {
    const { convex } = anlage();
    await fuellen(auftrag(convex, "a".repeat(64), 1), new AbortController().signal);
    const altesPaket = (await paketFuer(HEFT, "leser-1"))!;
    const listen = convex.query.getMockImplementation()!;
    convex.query.mockImplementation(async (ref: unknown, args: Record<string, unknown>) => {
      if (getFunctionName(ref as never) === "issuePages:listForReader") {
        return [
          { index: 0, printedLabel: "U1", role: "cover", width: 1000, height: 1400, stand: "neu" },
          { index: 1, printedLabel: "2", role: "content", width: 1000, height: 1400, stand: "b" },
        ];
      }
      return listen(ref, args);
    });
    await fuellen(auftrag(convex, "b".repeat(64), 2), new AbortController().signal);
    const neuesPaket = (await paketFuer(HEFT, "leser-1"))!;
    expect(neuesPaket.id).not.toBe(altesPaket.id);
    expect(altesPaket.tot).toBe(true);
    expect((await neuesPaket.kachel(0, "neu", 2, 0, 0))?.k).toBe(2);
  });

  it("hoert auf, wenn der Speicher des Geraets voll ist", async () => {
    const { geholt, convex } = anlage();
    const voll = new SpeicherAblage();
    // Kopf, Listen, Schriften und der Text passen noch, die Seiten nicht mehr.
    let erlaubt = 8;
    const schreiben = voll.schreiben.bind(voll);
    voll.schreiben = async (slot, wert) => {
      if (--erlaubt < 0) throw new DOMException("voll", "QuotaExceededError");
      return schreiben(slot, wert);
    };
    pufferAblageSetzen(voll);
    await expect(
      fuellen(auftrag(convex, "q".repeat(64), 1), new AbortController().signal),
    ).rejects.toThrow("voll");
    // Nicht jede Kachel noch geholt und weggeworfen.
    expect(geholt.filter((u) => u.includes("/tile/")).length).toBeLessThan(6);
  });

  it("puffert nichts ohne Zugriff", async () => {
    const { convex } = anlage();
    const listen = convex.query.getMockImplementation()!;
    convex.query.mockImplementation(async (ref: unknown, args: Record<string, unknown>) =>
      getFunctionName(ref as never) === "issues:getPublic"
        ? { _id: HEFT, title: "Testheft", owned: false }
        : listen(ref, args),
    );
    await fuellen(auftrag(convex, "c".repeat(64), 1), new AbortController().signal);
    expect(await paketFuer(HEFT, "leser-1")).toBeNull();
    expect(ablage.daten.size).toBe(0);
  });
});
