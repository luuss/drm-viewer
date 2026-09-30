/**
 * Die Tafeln eines Umschlags: welche Stelle welcher Quellseite U1 bis U4 ist.
 *
 * Ein Umschlag kommt aus der Druckvorstufe in einer von drei Formen:
 *
 * * zwei Boegen quer — aussen U4|U1, innen U2|U3. Ein Bogen kann breiter sein
 *   als zwei Seiten: ein Ruecken zwischen den Tafeln (Greim) oder eine
 *   Klappe (DMZ-Zeitgeschichte). Genommen werden deshalb die aeusseren Tafeln
 *   in Netzbreite; was dazwischen liegt, gehoert keiner Leserseite.
 * * vier Einzelseiten in Bogenreihenfolge — U4, U1, U2, U3 (ZUERST!).
 * * Einzelseiten in Lesereihenfolge — eine (nur U1) oder zwei (U1, U4).
 *
 * Reines Rechnen, ohne pdf.js: so laesst es sich an den echten Massen der
 * Hefte pruefen.
 */

import type { Schnitt } from "./textLayer";

export type TafelRolle = "front_cover" | "inside_front" | "inside_back" | "back_cover";

export type Tafel = {
  role: TafelRolle;
  printedLabel: "U1" | "U2" | "U3" | "U4";
  /** 0-basierte Seite der Umschlagdatei. */
  quellSeite: number;
  /** Der Ausschnitt dieser Seite, in Punkt, Ursprung oben links. */
  schnitt: Schnitt;
};

/** Eine Seite der Umschlagdatei in Punkt; `trim` ist ihr Netzformat darin. */
export type Quellseite = {
  breite: number;
  hoehe: number;
  trim?: Schnitt;
};

export type Netz = { pageWidthPt: number; pageHeightPt: number };

/** Ab diesem Verhaeltnis ist eine Seite ein Bogen mit mehreren Tafeln. */
const QUER_AB = 1.2;

function rahmen(seite: Quellseite): Schnitt {
  return seite.trim ?? { links: 0, oben: 0, breite: seite.breite, hoehe: seite.hoehe };
}

function tafel(
  role: TafelRolle,
  printedLabel: Tafel["printedLabel"],
  quellSeite: number,
  schnitt: Schnitt,
): Tafel {
  return { role, printedLabel, quellSeite, schnitt };
}

/**
 * Die Tafeln in Lesereihenfolge: `vorn` (U1, U2) vor dem Innenteil, `hinten`
 * (U3, U4) dahinter. Was der Umschlag nicht hat, fehlt einfach.
 */
export function umschlagTafeln(
  seiten: Quellseite[],
  netz?: Netz,
): { vorn: Tafel[]; hinten: Tafel[] } {
  if (!seiten.length) return { vorn: [], hinten: [] };
  const erste = rahmen(seiten[0]);

  if (erste.breite > erste.hoehe * QUER_AB) {
    // Boegen: aeussere Tafeln in Netzbreite, in der Hoehe mittig im Netzformat.
    const tafelAuf = (seite: number, kante: "links" | "rechts") => {
      const r = rahmen(seiten[seite]);
      const breite = Math.min(r.breite, netz?.pageWidthPt ?? r.breite / 2);
      const hoehe = Math.min(r.hoehe, netz?.pageHeightPt ?? r.hoehe);
      return {
        links: kante === "links" ? r.links : r.links + r.breite - breite,
        oben: r.oben + (r.hoehe - hoehe) / 2,
        breite,
        hoehe,
      };
    };
    const vorn = [tafel("front_cover", "U1", 0, tafelAuf(0, "rechts"))];
    const hinten: Tafel[] = [];
    if (seiten.length >= 2) {
      vorn.push(tafel("inside_front", "U2", 1, tafelAuf(1, "links")));
      hinten.push(tafel("inside_back", "U3", 1, tafelAuf(1, "rechts")));
    }
    hinten.push(tafel("back_cover", "U4", 0, tafelAuf(0, "links")));
    return { vorn, hinten };
  }

  const ganz = (seite: number) => rahmen(seiten[seite]);
  const n = seiten.length;
  if (n === 4) {
    // Bogenreihenfolge U4, U1, U2, U3.
    return {
      vorn: [tafel("front_cover", "U1", 1, ganz(1)), tafel("inside_front", "U2", 2, ganz(2))],
      hinten: [tafel("inside_back", "U3", 3, ganz(3)), tafel("back_cover", "U4", 0, ganz(0))],
    };
  }
  if (n === 2) {
    return {
      vorn: [tafel("front_cover", "U1", 0, ganz(0))],
      hinten: [tafel("back_cover", "U4", 1, ganz(1))],
    };
  }
  if (n === 1) {
    return { vorn: [tafel("front_cover", "U1", 0, ganz(0))], hinten: [] };
  }
  // Drei oder mehr als vier Seiten: Lesereihenfolge, die letzten beiden hinten.
  return {
    vorn: [tafel("front_cover", "U1", 0, ganz(0)), tafel("inside_front", "U2", 1, ganz(1))],
    hinten:
      n === 3
        ? [tafel("inside_back", "U3", 2, ganz(2))]
        : [tafel("inside_back", "U3", n - 2, ganz(n - 2)), tafel("back_cover", "U4", n - 1, ganz(n - 1))],
  };
}
