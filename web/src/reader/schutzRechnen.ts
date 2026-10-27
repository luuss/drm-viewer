/**
 * Zufallsfunktionen des Kopierschutzes, ohne Abhaengigkeiten. Sie muessen
 * Bit fuer Bit wie `tile-service/schutz.py` rechnen; `convex/schutz.test.ts`
 * vergleicht beide.
 */

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export function vertauschung(n: number, seed: number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  const r = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = r() % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** Je Block: Drehung in Vierteln, Zeilen- und Spaltenbaender (je 8 Bit). */
export function umformungen(n: number, seed: number): Array<[number, number, number]> {
  const r = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) out.push([r() % 4, r() & 0xff, r() & 0xff]);
  return out;
}
