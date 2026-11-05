import { beforeAll, describe, expect, test, vi } from "vitest";

// Die Reihen haengen an der Marke; sie wird beim Laden des Moduls gewaehlt.
let mod: typeof import("./kioskWeltkrieg");
beforeAll(async () => {
  vi.stubEnv("VITE_MARKE", "weltkrieg");
  vi.resetModules();
  mod = await import("./kioskWeltkrieg");
});

const monat = (jahr: number, m: number) => Date.UTC(jahr, m - 1, 15);
const heft = (
  id: string,
  publicationName: string | null,
  issueNumber: string | null,
  publicationDate: number | null = null,
) => ({
  _id: id,
  slug: id,
  displayTitle: id,
  edition: null,
  publicationName,
  coverUrl: null,
  issueNumber,
  publicationDate,
});

// Wie vom Server, Reihen und Folge durcheinander. Originalband 2 liegt nur
// als neue E-Book-Fassung im Archiv und hat kein Datum.
const HEFTE = [
  heft("blitz-3", "Blitzkrieg", "3", monat(2026, 7)),
  heft("orig-2", "Weltkrieg Originalband", "2"),
  heft("doppel-153", "Weltkrieg Doppelband", "153", monat(2025, 8)),
  heft("orig-334", "Weltkrieg Originalband", "334", monat(2026, 10)),
  heft("doppel-154", "Weltkrieg Doppelband", "154", monat(2025, 9)),
  heft("fremd-1", "Sonderheft", null),
  heft("orig-335", "Weltkrieg Originalband", "335", monat(2026, 11)),
];

describe("Kiosk Weltkrieg", () => {
  test("Reihen in der Folge des Ladens, darin hoechste Nummer zuerst", () => {
    const reihen = mod.kioskReihen(HEFTE);
    expect(reihen.map((r) => r.key)).toEqual(["originalband", "doppelband", "blitzkrieg", "sonderheft"]);
    // Auch ohne Datum: Nr. 2 ist das aelteste Heft der Reihe.
    expect(reihen[0].hefte.map((h) => h._id)).toEqual(["orig-335", "orig-334", "orig-2"]);
    expect(reihen[1].hefte.map((h) => h._id)).toEqual(["doppel-154", "doppel-153"]);
    expect(reihen[3].reihe).toBeNull();
    expect(reihen[3].name).toBe("Sonderheft");
  });

  test("Neueste: genau ein Heft je Reihe, das mit der hoechsten Nummer", () => {
    expect(mod.neuesteJeReihe(HEFTE).map((h) => h._id)).toEqual([
      "orig-335",
      "doppel-154",
      "blitz-3",
      "fremd-1",
    ]);
  });

  test("Alle: nach Datum ueber die Reihen, Hefte ohne Datum hinten", () => {
    expect(mod.alleNachNeuigkeit(HEFTE).map((h) => h._id)).toEqual([
      "orig-335",
      "orig-334",
      "blitz-3",
      "doppel-154",
      "doppel-153",
      "orig-2",
      "fremd-1",
    ]);
  });

  test("Ansicht aus der Adresse, sonst Kategorien", () => {
    expect(mod.kioskAnsicht("alle")).toBe("alle");
    expect(mod.kioskAnsicht("neueste")).toBe("neueste");
    expect(mod.kioskAnsicht(null)).toBe("kategorien");
    expect(mod.kioskAnsicht("quatsch")).toBe("kategorien");
  });
});
