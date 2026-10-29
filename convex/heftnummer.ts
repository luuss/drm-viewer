/**
 * Heftnummern lesen, vereinheitlichen, ordnen.
 *
 * Gespeichert wird eine Heftnummer immer in einer von vier Formen:
 *
 *   "3/2026"     Monatsheft (ZUERST!): Monat/Jahr
 *   "8-9/2025"   Doppelheft: erster und letzter Monat, Jahr
 *   "170"        laufende Nummer (DMZ, DMZ-Zeitgeschichte, Schwertertraeger)
 *   "170-171"    laufende Doppelnummer
 *
 * Die Druckvorstufe schreibt Ordner und Dateien dagegen frei: "zuerst
 * 8-9-2025", "8/9 2025", "8+9 2025", "08_09_2025", "zuerst 2026-07-08",
 * "Heft 7-8 2026", "Doppelausgabe 7/2026". `findeHeftnummer` liest all das,
 * `normalisiereHeftnummer` macht daraus die gespeicherte Form.
 *
 * Ein Doppelheft liegt nur vor, wenn die zweite Zahl direkt auf die erste
 * folgt ("8-9", "170-171"). "s. 20-39" oder "12-15" sind Seitenbereiche.
 * Ein Datum mit Punkten ("28.10.2026") ist nie eine Heftnummer.
 *
 * Reine Funktionen ohne Convex-Bezug; die Oberflaeche nutzt sie mit
 * (web/src/admin/folderScan.ts, web/src/lib/erscheinung.ts).
 */

export type Heftnummer = {
  /** Erste Nummer: Monat bei Monatsheften, sonst laufende Nummer. */
  von: number;
  /** Letzte Nummer; bei einem Einzelheft gleich `von`. */
  bis: number;
  /** Jahr, nur bei Monatsheften. */
  jahr?: number;
};

export const JAHR_MIN = 1950;
export const JAHR_MAX = 2099;

export function jahrPlausibel(jahr: number): boolean {
  return Number.isInteger(jahr) && jahr >= JAHR_MIN && jahr <= JAHR_MAX;
}

function istMonat(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

/** Folgt `b` direkt auf `a`? Nur dann ist "a-b" ein Doppelheft. */
function folgt(a: number, b: number): boolean {
  return b === a + 1;
}

export function formatHeftnummer(h: Heftnummer): string {
  const nummer = h.bis !== h.von ? `${h.von}-${h.bis}` : `${h.von}`;
  return h.jahr !== undefined ? `${nummer}/${h.jahr}` : nummer;
}

export function istDoppelheft(h: Heftnummer | null | undefined): boolean {
  return !!h && h.bis !== h.von;
}

export type Fund = {
  heft: Heftnummer;
  /** Stelle im Text, an der die Nummer beginnt. */
  index: number;
  /** Laenge der Fundstelle im Text. */
  laenge: number;
  /** Was an der Nummer nicht stimmt, etwa ein Tippfehler im Jahr. */
  problem?: string;
};

// Trenner zwischen den beiden Nummern eines Doppelhefts und vor dem Jahr.
// Ein Leerzeichen allein trennt auch ("8 9 2025", aus "08_09_2025").
const ZWISCHEN = String.raw`\s*(?:[-+/&]|und)\s*|\s+`;
const VOR_JAHR = String.raw`\s*[-/]\s*|\s+`;

/**
 * Die Heftnummer in einem Ordner- oder Dateinamen finden.
 *
 * Gesucht wird in dieser Reihenfolge: Doppelheft mit Jahr ("8-9-2025"),
 * Monatsheft mit Jahr ("3-2026"), Jahr vorn ("2026-07-08", "2026-03"),
 * laufende Doppelnummer ("170-171") und zuletzt die erste Zahl ("170").
 * `doppel` sagt, dass der Name "Doppelausgabe" o. ae. enthaelt: dann wird aus
 * einem einzelnen Monat ("Doppelausgabe 7/2026") das Doppelheft 7-8/2026.
 */
export function findeHeftnummer(text: string, doppel = false): Fund | null {
  // Daten mit Punkten ("28.10.2026", "8.9.25") ausblenden, ohne die
  // Stellen zu verschieben: sie sind nie eine Heftnummer.
  const leer = (m: string) => " ".repeat(m.length);
  const t = text
    .replace(/\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})\b/g, leer)
    // Tagesdatum mit Jahr vorn ("2026-07-15"): kein Heft, auch nicht "2026".
    // "2026-07-08" bleibt stehen, das liest Schritt 3 als Doppelheft 7-8.
    .replace(/(?<!\d)((?:19|20)\d{2})[-_ ](\d{1,2})[-_ ](\d{1,2})(?!\d)/g, (m, _j, a, b) =>
      istMonat(Number(a)) && istMonat(Number(b)) && folgt(Number(a), Number(b)) ? m : leer(m),
    );

  // 1. Doppelheft mit Jahr: "8-9-2025", "8/9 2025", "8+9 2025", "08 09 2025".
  const doppelJahr = new RegExp(
    String.raw`(?<!\d)(\d{1,2})(?:${ZWISCHEN})(\d{1,2})(?:${VOR_JAHR})(\d{4})(?!\d)`,
    "g",
  );
  for (const m of t.matchAll(doppelJahr)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const jahr = Number(m[3]);
    if (!istMonat(a) || !istMonat(b) || !folgt(a, b)) continue;
    return mitJahr({ von: a, bis: b, jahr }, m.index ?? 0, m[0].length);
  }

  // 2. Monatsheft mit Jahr: "3-2026", "3/2026", "3 2026", auch "6-6026"
  // (Tippfehler im Jahr, wird gemeldet statt verschluckt).
  const monatJahr = new RegExp(String.raw`(?<!\d)(\d{1,2})(?:${VOR_JAHR})(\d{4})(?!\d)`, "g");
  for (const m of t.matchAll(monatJahr)) {
    const a = Number(m[1]);
    const jahr = Number(m[2]);
    if (!istMonat(a)) continue;
    // "3 2026" mit Leerzeichen nur bei einem plausiblen Jahr: sonst waere
    // "dmz 1 1000" ein Heft.
    if (/^\d{1,2}\s+\d{4}$/.test(m[0]) && !jahrPlausibel(jahr)) continue;
    const bis = doppel && a < 12 ? a + 1 : a;
    return mitJahr({ von: a, bis, jahr }, m.index ?? 0, m[0].length);
  }

  // 3. Jahr vorn: "2026-07-08" (Doppelheft), "2026-07", "2026_03".
  const jahrVorn = /(?<!\d)((?:19|20)\d{2})[-_ ](\d{1,2})(?:[-_ +/](\d{1,2}))?(?!\d)/g;
  for (const m of t.matchAll(jahrVorn)) {
    const jahr = Number(m[1]);
    const a = Number(m[2]);
    const b = m[3] !== undefined ? Number(m[3]) : undefined;
    if (!istMonat(a)) continue;
    if (b !== undefined && !(istMonat(b) && folgt(a, b))) {
      // "2026-07-15" ist ein Tagesdatum, kein Heft.
      continue;
    }
    const bis = b ?? (doppel && a < 12 ? a + 1 : a);
    return mitJahr({ von: a, bis, jahr }, m.index ?? 0, m[0].length);
  }

  // 4./5. Laufende Nummer: die erste Zahl im Namen, mit direkt folgender
  // zweiter als Doppelnummer ("170-171", "170/171"). Spaetere Zahlen sind
  // Seiten ("dmz 101 S. 21-22") und zaehlen nicht.
  const erste = /(?<!\d)(\d{1,4})(?!\d)/.exec(t);
  if (!erste) return null;
  const von = Number(erste[1]);
  const start = erste.index;
  const danach = /^\s*[-+/]\s*(\d{1,4})(?!\d)/.exec(t.slice(start + erste[0].length));
  if (danach && folgt(von, Number(danach[1]))) {
    return {
      heft: { von, bis: Number(danach[1]) },
      index: start,
      laenge: erste[0].length + danach[0].length,
    };
  }
  return { heft: { von, bis: von }, index: start, laenge: erste[0].length };
}

function mitJahr(heft: Heftnummer, index: number, laenge: number): Fund {
  const jahr = heft.jahr as number;
  return {
    heft,
    index,
    laenge,
    problem: jahrPlausibel(jahr)
      ? undefined
      : `Jahr ${jahr} in der Heftnummer ${formatHeftnummer(heft)} kann nicht stimmen`,
  };
}

/** "Doppelausgabe", "Doppelheft", "Doppelnummer" im Namen. */
export const DOPPEL_WORT = /\bdoppel(?:ausgabe|heft|nummer)\b/i;

/**
 * Eine Heftnummer, wie sie jemand eintippt oder wie sie gespeichert ist, in
 * die gespeicherte Form bringen: "08/09 2025" -> "8-9/2025". Liest sich die
 * Eingabe nicht vollstaendig als Heftnummer, kommt null zurueck.
 */
export function leseHeftnummer(eingabe: string | null | undefined): Heftnummer | null {
  const text = (eingabe ?? "")
    .replace(/_/g, " ")
    .replace(/\b(?:nr\.?|heft|ausgabe)\s*/gi, "")
    .replace(DOPPEL_WORT, "")
    .trim();
  if (!text) return null;
  const fund = findeHeftnummer(text, DOPPEL_WORT.test(eingabe ?? ""));
  if (!fund || fund.index !== 0 || fund.laenge !== text.length) return null;
  return fund.heft;
}

export function normalisiereHeftnummer(eingabe: string | null | undefined): string | null {
  const heft = leseHeftnummer(eingabe);
  return heft ? formatHeftnummer(heft) : null;
}

/** Problem mit einer Heftnummer (unmoegliches Jahr), sonst null. */
export function heftnummerProblem(eingabe: string | null | undefined): string | null {
  const heft = leseHeftnummer(eingabe);
  if (!heft || heft.jahr === undefined || jahrPlausibel(heft.jahr)) return null;
  return `Jahr ${heft.jahr} in der Heftnummer ${formatHeftnummer(heft)} kann nicht stimmen`;
}

/** Gleiche Hefte, auch wenn die Nummer verschieden geschrieben ist. */
export function gleicheHeftnummer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalisiereHeftnummer(a) ?? a.trim();
  const nb = normalisiereHeftnummer(b) ?? b.trim();
  return na === nb;
}

export const MONATSNAMEN = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/**
 * Erscheinungsmonate eines Monatshefts aus seiner Nummer: "8-9/2025" ->
 * August bis September 2025. Laufende Nummern sagen nichts ueber den Monat.
 */
export function monateDerNummer(
  nummer: string | null | undefined,
): { von: number; bis: number; jahr: number } | null {
  const heft = leseHeftnummer(nummer);
  if (!heft || heft.jahr === undefined || !jahrPlausibel(heft.jahr)) return null;
  if (!istMonat(heft.von) || !istMonat(heft.bis)) return null;
  return { von: heft.von, bis: heft.bis, jahr: heft.jahr };
}

/** "August/September 2025", "März 2026"; null ohne Monat in der Nummer. */
export function zeitraumDerNummer(nummer: string | null | undefined): string | null {
  const m = monateDerNummer(nummer);
  if (!m) return null;
  const monate =
    m.von === m.bis
      ? MONATSNAMEN[m.von - 1]
      : `${MONATSNAMEN[m.von - 1]}/${MONATSNAMEN[m.bis - 1]}`;
  return `${monate} ${m.jahr}`;
}

/**
 * Ordnungszeitpunkt eines Hefts, neueste zuerst sortierbar: das
 * Erscheinungsdatum, sonst der erste Monat aus der Nummer ("8-9/2025" ->
 * 1. August 2025), sonst der Tag des Anlegens. Ohne den zweiten Schritt
 * rutschte ein nachtraeglich importiertes altes Heft im Kiosk nach vorn.
 */
export function heftZeitpunkt(issue: {
  publicationDate?: number | null;
  issueNumber?: string | null;
  createdAt: number;
}): number {
  if (issue.publicationDate) return issue.publicationDate;
  const m = monateDerNummer(issue.issueNumber);
  if (m) return Date.UTC(m.jahr, m.von - 1, 1);
  return issue.createdAt;
}

/** Erste laufende Nummer ("170-171" -> 170), fuer die Ordnung im Jahr. */
export function ersteNummer(nummer: string | null | undefined): number | null {
  const heft = leseHeftnummer(nummer);
  return heft ? heft.von : null;
}
