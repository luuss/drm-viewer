/**
 * Titel und Reihe eines Hefts von seiner Titelseite (Weltkrieg-Leser).
 *
 * Die Ordnernamen der Druckvorstufe tragen weder die Reihe noch zuverlaessig
 * den Titel ("159d Sturm zum Finnenmeer-Baltikum 1941"). Die Titelseite schon:
 * oben der Schriftzug, darunter in der groessten Schrift der Titel, und die
 * Reihe steht als Wort dabei ("erlebnisberichte – Doppelband"). Der Buchstabe
 * hinter der Nummer ist kein Beleg fuer die Reihe; es zaehlt, was gedruckt ist.
 *
 * Nur die Titelseite (U1) wird gelesen. Auf U4 stehen Anzeigen fuer andere
 * Reihen ("FREIKORPS behandelt …").
 */

import type { TextItem } from "./textLayer";

/** Der Schriftzug steht oben; was darunter in der groessten Schrift steht, ist der Titel. */
const KOPF_BIS = 0.22;
/** Kleiner als diese Schrift ist kein Titel mehr, sondern Unterzeile. */
const TITEL_MINDESTGROESSE = 20;
/** Zeilen gleicher Groesse (auf diese Spanne) gehoeren zum selben Titel. */
const GROESSEN_SPANNE = 0.12;

export type UmschlagName = {
  /** Titel wie gedruckt, in Versalien auf dem Umschlag. */
  titelGedruckt: string;
  /** Name der Reihe, wie ihn die Liste der Anlage fuehrt. */
  reihe: string | null;
};

type Reihe = { name: string; match: RegExp };

function gerade(i: TextItem): boolean {
  return i.length < 7 || !i[6] || i[6] % 360 === 0;
}

export function nameVomUmschlag(items: TextItem[], reihen: Reihe[]): UmschlagName | null {
  const flach = items.filter((i) => gerade(i) && i[0].trim());
  const unten = flach.filter((i) => i[2] >= KOPF_BIS);
  const groesste = Math.max(0, ...unten.map((i) => i[5]));
  let titelGedruckt = "";
  if (groesste >= TITEL_MINDESTGROESSE) {
    titelGedruckt = unten
      .filter((i) => i[5] >= groesste * (1 - GROESSEN_SPANNE))
      .sort((a, b) => a[2] - b[2] || a[1] - b[1])
      .map((i) => i[0].trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const text = flach.map((i) => i[0]).join(" ");
  // Die Reihe als eigenes Wort auf der Titelseite. Der Schriftzug der Anlage
  // ("WELTKRIEG") passt auf keine Reihe; steht keine da, bleibt es offen.
  const reihe = reihen.find((r) => r.match.test(text))?.name ?? null;
  if (!titelGedruckt && !reihe) return null;
  return { titelGedruckt, reihe };
}

/**
 * Der Titel in der Schreibung des Satzes. Der Umschlag setzt Versalien;
 * im Innenteil steht derselbe Titel meist richtig geschrieben ("Der lange
 * Schatten der Vergangenheit"). Gesucht wird ohne Ruecksicht auf Gross- und
 * Kleinschreibung und Zeilenumbrueche.
 */
export function schreibungAusSatz(titel: string, satzTexte: string[]): string | null {
  const muster = titel
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\u00ad-]+");
  if (!muster) return null;
  const re = new RegExp(`(?<![\\p{L}])${muster}(?![\\p{L}])`, "iu");
  for (const text of satzTexte) {
    const fund = re.exec(text);
    if (fund) {
      const s = fund[0].replace(/[\s­]+/g, " ").trim();
      // Nur eine echte andere Schreibung zaehlt, nicht dieselben Versalien.
      if (s !== s.toUpperCase()) return s;
    }
  }
  return null;
}

/** Kleine Woerter, die im Titel klein bleiben (ausser am Anfang). */
const KLEIN = new Set(
  ("der die das des dem den ein eine einer eines einem einen und oder auf aus " +
    "bei bis durch fuer für gegen im in ins am an vom von vor zu zum zur mit nach " +
    "ueber über unter um wie als ohne zwischen hinter neben").split(" "),
);

/**
 * Ohne Fund im Satz: aus Versalien einen lesbaren Titel. Hauptwoerter kennt
 * die Regel nicht; darum gross, ausser den kleinen Woertern ("Alles auf eine
 * Karte"). Ein Adjektiv steht dann falsch gross, das ist der kleinere Fehler.
 */
export function ausVersalien(titel: string): string {
  if (titel !== titel.toUpperCase()) return titel;
  return titel
    .toLocaleLowerCase("de-DE")
    .split(/(\s+|-)/)
    .map((wort, i) =>
      i > 0 && KLEIN.has(wort) ? wort : wort.charAt(0).toLocaleUpperCase("de-DE") + wort.slice(1),
    )
    .join("");
}
