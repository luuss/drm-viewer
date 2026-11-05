import { beforeAll, describe, expect, test, vi } from "vitest";

// Die Reihen haengen an der Marke; sie wird beim Laden des Moduls gewaehlt.
let mod: typeof import("./kioskWeltkrieg");
beforeAll(async () => {
  vi.stubEnv("VITE_MARKE", "weltkrieg");
  vi.resetModules();
  mod = await import("./kioskWeltkrieg");
});

const heft = (id: string, publicationName: string | null) => ({
  _id: id,
  slug: id,
  displayTitle: id,
  edition: null,
  publicationName,
  coverUrl: null,
});

// Wie vom Server: neueste zuerst, Reihen durcheinander.
const HEFTE = [
  heft("blitz-3", "Blitzkrieg"),
  heft("doppel-154", "Weltkrieg Doppelband"),
  heft("orig-335", "Weltkrieg Originalband"),
  heft("doppel-153", "Weltkrieg Doppelband"),
  heft("fremd-1", "Sonderheft"),
  heft("orig-334", "Weltkrieg Originalband"),
];

describe("Kiosk Weltkrieg", () => {
  test("Reihen in der Folge des Ladens, Hefte darin neueste zuerst", () => {
    const reihen = mod.kioskReihen(HEFTE);
    expect(reihen.map((r) => r.key)).toEqual(["originalband", "doppelband", "blitzkrieg", "sonderheft"]);
    expect(reihen[0].hefte.map((h) => h._id)).toEqual(["orig-335", "orig-334"]);
    expect(reihen[1].hefte.map((h) => h._id)).toEqual(["doppel-154", "doppel-153"]);
    // Ohne bekannte Reihe: unter dem eigenen Namen, ohne Schriftzug.
    expect(reihen[3].reihe).toBeNull();
    expect(reihen[3].name).toBe("Sonderheft");
  });

  test("Neueste: genau ein Heft je Reihe", () => {
    expect(mod.neuesteJeReihe(HEFTE).map((h) => h._id)).toEqual([
      "orig-335",
      "doppel-154",
      "blitz-3",
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
