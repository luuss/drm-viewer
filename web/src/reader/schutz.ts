/**
 * Kopierschutz im Reader: verwuerfelte Kacheln und Bilder zusammensetzen,
 * Leseschrift der Sitzung laden.
 *
 * Das Gateway liefert Kacheln und Artikelbilder in vertauschten Bloecken
 * (`tile-service/schutz.py`). Erst hier entsteht das lesbare Bild, und zwar nur
 * auf einer Zeichenflaeche oder als `blob:`-Adresse. Die Zufallsfunktionen
 * muessen Bit fuer Bit wie dort rechnen (`convex/schutz.test.ts`).
 */
import { TILE_SERVICE_URL } from "../lib/api";

const BLOCK = 64;

export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((t + (Math.imul(t ^ (t >>> 7), 61 | t) >>> 0)) >>> 0) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function vertauschung(n: number, seed: number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  const r = mulberry32(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = r() % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** Block k des verwuerfelten Bildes gehoert an die Stelle p[k]. */
export function zusammensetzen(bild: ImageBitmap, seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bild.width;
  canvas.height = bild.height;
  const ctx = canvas.getContext("2d")!;
  // Randstreifen ausserhalb der vollen Bloecke sind nicht vertauscht.
  ctx.drawImage(bild, 0, 0);
  const spalten = Math.floor(bild.width / BLOCK);
  const zeilen = Math.floor(bild.height / BLOCK);
  const n = spalten * zeilen;
  if (n >= 2) {
    const p = vertauschung(n, seed);
    for (let k = 0; k < n; k++) {
      const q = p[k];
      ctx.drawImage(
        bild,
        (k % spalten) * BLOCK,
        Math.floor(k / spalten) * BLOCK,
        BLOCK,
        BLOCK,
        (q % spalten) * BLOCK,
        Math.floor(q / spalten) * BLOCK,
        BLOCK,
        BLOCK,
      );
    }
  }
  bild.close();
  return canvas;
}

export function kachelSeed(
  k: number,
  issueId: string,
  pageIndex: string,
  level: string,
  col: string,
  row: string,
) {
  return fnv1a32(`${k}:${issueId}:${pageIndex}:${level}:${col}:${row}`);
}

/**
 * Artikelbild ueber die Sitzung holen und als `blob:`-Adresse liefern. Im
 * HTML steht so kein Pfad zum Server.
 */
export async function bildAlsBlob(
  url: string,
  sessionToken: string,
  k: number,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(url, { headers: { "X-Tile-Session": sessionToken }, signal });
  if (!res.ok) throw new Error(`Bild ${res.status}`);
  const daten = await res.blob();
  const assetId = /\/api\/asset\/([^/?.]+)\.jpg/.exec(url)?.[1];
  if (res.headers.get("X-Seg") !== "1" || !assetId) return URL.createObjectURL(daten);
  const canvas = zusammensetzen(
    await createImageBitmap(daten),
    fnv1a32(`${k}:asset:${assetId}`),
  );
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.92));
  if (!blob) throw new Error("Bild nicht zusammengesetzt");
  return URL.createObjectURL(blob);
}

/** Leseschriften der Sitzung. Ihre Zeichentabelle passt nur zu deren Text. */
export const SCHUTZ_SCHRIFTEN = [
  { datei: "sans", familie: "LusLeseSans", style: "normal", weight: "300 800" },
  { datei: "serif", familie: "LusLeseSerif", style: "normal", weight: "400 900" },
  { datei: "serif-kursiv", familie: "LusLeseSerif", style: "italic", weight: "400 900" },
] as const;

export async function schriftenLaden(
  sessionToken: string,
  signal: AbortSignal,
): Promise<FontFace[]> {
  return Promise.all(
    SCHUTZ_SCHRIFTEN.map(async (s) => {
      const res = await fetch(`${TILE_SERVICE_URL}/api/schrift/${s.datei}`, {
        headers: { "X-Tile-Session": sessionToken },
        signal,
      });
      if (!res.ok) throw new Error(`Schrift ${res.status}`);
      const face = new FontFace(s.familie, await res.arrayBuffer(), {
        style: s.style,
        weight: s.weight,
        display: "block",
      });
      await face.load();
      return face;
    }),
  );
}
