/**
 * Kopierschutz fuer den Lesetext.
 *
 * Der Artikeltext verlaesst den Server nie im Klartext. Jedes Zeichen aus
 * `SCHUTZ_ALPHABET` wird auf einen Platz im Unicode-Privatbereich (ab U+E000)
 * gelegt; jedes Zeichen hat zwei solche Plaetze, gewaehlt wird je Vorkommen.
 * Das Kachel-Gateway baut zur selben Lesesitzung eine Schrift, deren
 * Zeichentabelle genau diese Plaetze auf die richtigen Glyphen zeigt
 * (`tile-service/schutz.py`). Der Leser sieht normalen Text, im HTML und in
 * der Zwischenablage steht Zeichensalat.
 *
 * Die Vertauschung haengt am Geheimwert der Lesesitzung (`schutzSeed`), den
 * der Browser nie bekommt. Dieselben Funktionen stehen in Python in
 * `tile-service/schutz.py`; `schutz.test.ts` haelt beide gleich.
 */

/**
 * Zeichen, die verschluesselt werden. Alle stehen in den drei Lesesschriften
 * (Open Sans, Playfair Display normal und kursiv). Leerzeichen und weiche
 * Trennstriche bleiben, damit der Browser weiter Zeilen umbricht.
 */
export const SCHUTZ_ALPHABET =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`" +
  "abcdefghijklmnopqrstuvwxyz{|}~¡¢£¤¥¦§¨©ª«¬®¯°±²³´¶·¸¹º»¼½¾¿" +
  "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ" +
  "–—‘’‚“”„…€•‹›";

export const SCHUTZ_PUA = 0xe000;

/** Bleibt in Tabellen stehen: daraus erkennt der Reader Zahlenspalten
 * (`ZAHL` in `web/src/lib/tabelle.ts`). */
const ZAHLZEICHEN = "0123456789.,:%/–-";

/** FNV-1a ueber die UTF-16-Einheiten, 32 Bit ohne Vorzeichen. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32: kleiner, in Python exakt nachbaubarer Zufallsstrom. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Fisher-Yates-Vertauschung von 0..n-1. */
export function vertauschung(n: number, seed: number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  const r = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = r() % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

export const schriftSchluessel = (seed: number) => fnv1a32(`${seed}:schrift`);
export const kachelSchluessel = (seed: number) => fnv1a32(`${seed}:kacheln`);

/** Zeichen -> seine zwei Plaetze im Privatbereich. */
function tabelle(seed: number): Map<string, [number, number]> {
  const p = vertauschung(SCHUTZ_ALPHABET.length * 2, schriftSchluessel(seed));
  const map = new Map<string, [number, number]>();
  [...SCHUTZ_ALPHABET].forEach((c, i) => {
    map.set(c, [SCHUTZ_PUA + p[2 * i], SCHUTZ_PUA + p[2 * i + 1]]);
  });
  return map;
}

/**
 * Verschluesseler fuer eine Lesesitzung. `wahl` macht die Wahl zwischen den
 * zwei Plaetzen eines Zeichens reproduzierbar (Convex-Abfragen muessen
 * deterministisch sein).
 */
export function verschluesseler(seed: number, wahl: string) {
  const map = tabelle(seed);
  const r = mulberry32(fnv1a32(`${seed}:wahl:${wahl}`));
  return (text: string, opts: { zahlenLassen?: boolean } = {}) => {
    let out = "";
    for (const c of text) {
      const plaetze = map.get(c);
      if (!plaetze || (opts.zahlenLassen && ZAHLZEICHEN.includes(c))) {
        out += c;
        continue;
      }
      out += String.fromCharCode(plaetze[r() & 1]);
    }
    return out;
  };
}

/** Nur fuer Tests und Fehlersuche: Klartext zurueckholen. */
export function entschluesseln(seed: number, text: string): string {
  const rueck = new Map<number, string>();
  for (const [c, [a, b]] of tabelle(seed)) {
    rueck.set(a, c);
    rueck.set(b, c);
  }
  let out = "";
  for (const c of text) out += rueck.get(c.charCodeAt(0)) ?? c;
  return out;
}
