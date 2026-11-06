import { REIHENFOLGE, reiheVon, reihenSchluessel, type Reihe } from "../lib/reihen";

/** Was der Kiosk je Heft braucht (aus `issues.listPublished`). */
export type KioskHeft = {
  _id: string;
  slug: string;
  displayTitle: string;
  edition: string | null;
  publicationName: string | null;
  coverUrl: string | null;
  issueNumber: string | null;
  publicationDate: number | null;
};

function nummer(h: KioskHeft): number | null {
  const m = /\d+/.exec(h.issueNumber ?? "");
  return m ? Number(m[0]) : null;
}

/** Hoehere Heftnummer zuerst; ohne Nummer bleibt die bisherige Folge. */
function nachNummer(a: KioskHeft, b: KioskHeft): number {
  const x = nummer(a);
  const y = nummer(b);
  return x === null || y === null ? 0 : y - x;
}

/**
 * Alle Hefte, neueste zuerst. Ein Erscheinungsdatum hat bei Weltkrieg nur,
 * wer es aus dem Heftarchiv bekam (Dateidatum des Innenteils, 05.11.2026);
 * fruehe Hefte, die nur als neue E-Book-Fassung im Archiv liegen, haben
 * keins. Sie stehen hinten, nach Nummer.
 */
export function alleNachNeuigkeit<H extends KioskHeft>(hefte: H[]): H[] {
  return [...hefte].sort((a, b) => {
    const da = a.publicationDate;
    const db = b.publicationDate;
    if (da && db && da !== db) return db - da;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return nachNummer(a, b);
  });
}

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
 * In einer Reihe gilt die Heftnummer: die hoechste ist das neueste Heft,
 * auch ohne Datum. Ein Heft ohne bekannte Reihe steht unter seinem
 * Zeitschriftennamen hinter den bekannten.
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
  for (const g of gruppen.values()) g.hefte.sort(nachNummer);
  return [...gruppen.values()].sort(
    (a, b) => rang(a.key) - rang(b.key) || a.name.localeCompare(b.name, "de"),
  );
}

/** Das neueste Heft jeder Reihe, in der Folge der Reihen. */
export function neuesteJeReihe<H extends KioskHeft>(hefte: H[]): H[] {
  return kioskReihen(hefte).map((g) => g.hefte[0]);
}
