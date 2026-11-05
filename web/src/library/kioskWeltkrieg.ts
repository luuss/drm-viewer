import { REIHENFOLGE, reiheVon, reihenSchluessel, type Reihe } from "../lib/reihen";

/** Was der Kiosk je Heft braucht (aus `issues.listPublished`). */
export type KioskHeft = {
  _id: string;
  slug: string;
  displayTitle: string;
  edition: string | null;
  publicationName: string | null;
  coverUrl: string | null;
};

export type KioskReihe<H extends KioskHeft> = {
  key: string;
  reihe: Reihe | null;
  name: string;
  /** Neueste zuerst, wie der Server sie liefert. */
  hefte: H[];
};

export type KioskAnsicht = "alle" | "kategorien" | "neueste";

export const KIOSK_ANSICHTEN: [KioskAnsicht, string][] = [
  ["alle", "Alle"],
  ["kategorien", "Kategorien"],
  ["neueste", "Neueste"],
];

export function kioskAnsicht(wert: string | null): KioskAnsicht {
  return KIOSK_ANSICHTEN.some(([a]) => a === wert) ? (wert as KioskAnsicht) : "kategorien";
}

function rang(key: string) {
  const i = REIHENFOLGE.indexOf(key);
  return i < 0 ? REIHENFOLGE.length : i;
}

/**
 * Die Hefte je Reihe, Reihen in der Folge der Menueleiste des Ladens.
 * `hefte` kommt neueste zuerst (`issues.listPublished`, `heftZeitpunkt`);
 * die Folge bleibt in jeder Reihe erhalten. Ein Heft ohne bekannte Reihe
 * steht unter seinem Zeitschriftennamen hinter den bekannten.
 */
export function kioskReihen<H extends KioskHeft>(hefte: H[]): KioskReihe<H>[] {
  const gruppen = new Map<string, KioskReihe<H>>();
  for (const h of hefte) {
    const key = reihenSchluessel(h.publicationName);
    let g = gruppen.get(key);
    if (!g) {
      const reihe = reiheVon(h.publicationName);
      g = { key, reihe, name: reihe?.name ?? h.publicationName ?? "Weitere Hefte", hefte: [] };
      gruppen.set(key, g);
    }
    g.hefte.push(h);
  }
  return [...gruppen.values()].sort(
    (a, b) => rang(a.key) - rang(b.key) || a.name.localeCompare(b.name, "de"),
  );
}

/** Das neueste Heft jeder Reihe, in der Folge der Reihen. */
export function neuesteJeReihe<H extends KioskHeft>(hefte: H[]): H[] {
  return kioskReihen(hefte).map((g) => g.hefte[0]);
}
