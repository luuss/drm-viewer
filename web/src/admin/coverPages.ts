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

/**
 * Wie sehr eine Tafel nach Titelseite aussieht, aus ihrer Textebene.
 *
 * Die Titelseite traegt oben den Schriftzug der Reihe in sehr grosser Schrift
 * ("WELTKRIEG" 100 pt, "Freikorps", "LEGION"), die Heftnummer ("Nr. 159")
 * und den Preis ("€ 4,95"). Rueckseite und Innenseiten haben das nicht.
 */
export function titelseitenWert(
  items: ReadonlyArray<readonly [string, number, number, number, number, number, number?]>,
  heftNummer?: string | null,
): number {
  let wert = 0;
  const oben = items.filter((i) => i[2] < 0.35);
  const groesste = Math.max(0, ...oben.map((i) => i[5]));
  if (groesste >= 50) wert += 3;
  else if (groesste >= 36) wert += 1;
  const text = items.map((i) => i[0]).join(" ");
  if (/\bnr\.?\s*\d+/i.test(text) || /\bno\.?\s*\d+/i.test(text)) wert += 2;
  if (/€\s?\d+,\d{2}/.test(text)) wert += 1;
  if (/www\.[a-z-]+\.(info|online|de)/i.test(text)) wert += 1;
  // Die eigene Nummer: Anzeigen fuer andere Hefte auf U3/U4 tragen alles
  // andere auch (Schriftzug, "Nr.", Preis), aber nicht diese Nummer.
  const nr = /^\d+/.exec(heftNummer ?? "")?.[0];
  if (nr && new RegExp(`\\b(nr|no)\\.?\\s*0*${nr}(?!\\d)`, "i").test(text)) wert += 5;
  return wert;
}

/**
 * Die Rollen der Tafeln nach dem Inhalt richten (Weltkrieg, 03.11.2026).
 *
 * Die Umschlag-PDFs der Druckvorstufe kommen in wechselnder Folge: mal
 * U4, U1, U2, U3, mal zuerst der innere Bogen. Nach der Position allein
 * stand bei "Zwei Treffer" der Kapitaen von U2 auf der Titelseite. Hier
 * gewinnt die Tafel, die nach Titelseite aussieht; ihre Partnerin auf
 * demselben Bogen (dieselbe Quellseite, sonst die Nachbarseite 0/1, 2/3)
 * ist U4, vom anderen Bogen kommt links U2, rechts U3. Sieht keine Tafel
 * eindeutig nach Titelseite aus, bleibt die Zuordnung nach Position.
 */
export function tafelnNachInhalt(
  tafeln: { vorn: Tafel[]; hinten: Tafel[] },
  texte: Map<Tafel, ReadonlyArray<readonly [string, number, number, number, number, number, number?]>>,
  heftNummer?: string | null,
): { vorn: Tafel[]; hinten: Tafel[] } {
  const alle = [...tafeln.vorn, ...tafeln.hinten];
  if (alle.length < 2) return tafeln;
  const werte = alle.map((t) => titelseitenWert(texte.get(t) ?? [], heftNummer));
  const ohneNummer = alle.map((t) => titelseitenWert(texte.get(t) ?? []));
  // Nur eine Tafel mit der eigenen Nummer kann die Titelseite sein. Ohne
  // sie ist eine Anzeige fuer ein anderes Heft (Schriftzug, "Nr.", Preis)
  // nicht sicher zu unterscheiden; dann bleibt es bei der Lage.
  const kandidaten = alle
    .map((t, i) => ({ t, w: werte[i], i }))
    .filter(({ i }) => werte[i] > ohneNummer[i]);
  if (!kandidaten.length) return tafeln;
  const best = Math.max(...kandidaten.map((k) => k.w));
  const beste = kandidaten.filter((k) => k.w === best);
  if (beste.length !== 1) return tafeln;
  const titel = beste[0].t;
  if (titel.role === "front_cover") return tafeln;
  const nachLage = (a: Tafel, b: Tafel) => a.quellSeite - b.quellSeite || a.schnitt.links - b.schnitt.links;
  const rest = alle.filter((t) => t !== titel);
  const gleicherBogen = rest.find((t) => t.quellSeite === titel.quellSeite);
  const partner =
    gleicherBogen ?? rest.find((t) => t.quellSeite === (titel.quellSeite ^ 1)) ?? null;
  const innen = rest.filter((t) => t !== partner).sort(nachLage);
  const neu = (t: Tafel, role: TafelRolle, printedLabel: Tafel["printedLabel"]): Tafel => ({
    ...t,
    role,
    printedLabel,
  });
  const vorn = [neu(titel, "front_cover", "U1")];
  if (innen[0]) vorn.push(neu(innen[0], "inside_front", "U2"));
  const hinten: Tafel[] = [];
  if (innen[1]) hinten.push(neu(innen[1], "inside_back", "U3"));
  if (partner) hinten.push(neu(partner, "back_cover", "U4"));
  return { vorn, hinten };
}
