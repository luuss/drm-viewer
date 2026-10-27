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

import { fnv1a32, umformungen, vertauschung } from "./schutzRechnen";

export { fnv1a32 };

const BLOCK = 64;

/**
 * Rueckweg zu `verwuerfeln` in `tile-service/schutz.py`, in umgekehrter
 * Folge: erst die Querstriche weg (8-px-Baender per "difference" mit Weiss
 * zurueck invertieren, Kreuzungen heben sich wie beim Server auf), dann jeden
 * Block zurueckdrehen und an seine Stelle p[k] setzen.
 */
export function zusammensetzen(bild: ImageBitmap, seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = bild.width;
  canvas.height = bild.height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const spalten = Math.floor(bild.width / BLOCK);
  const zeilen = Math.floor(bild.height / BLOCK);
  const n = spalten * zeilen;
  if (n < 2) {
    ctx.drawImage(bild, 0, 0);
    bild.close();
    return canvas;
  }

  // Stufe 2 rueckwaerts: Querstriche auf einer Zwischenflaeche entfernen.
  const zwischen = document.createElement("canvas");
  zwischen.width = bild.width;
  zwischen.height = bild.height;
  const z = zwischen.getContext("2d")!;
  z.drawImage(bild, 0, 0);
  bild.close();
  const formen = umformungen(n, seed);
  z.globalCompositeOperation = "difference";
  z.fillStyle = "#fff";
  for (let k = 0; k < n; k++) {
    const x = (k % spalten) * BLOCK;
    const y = Math.floor(k / spalten) * BLOCK;
    const [, zb, sb] = formen[k];
    for (let i = 0; i < BLOCK / 8; i++) {
      if ((zb >> i) & 1) z.fillRect(x, y + i * 8, BLOCK, 8);
    }
    for (let i = 0; i < BLOCK / 8; i++) {
      if ((sb >> i) & 1) z.fillRect(x + i * 8, y, 8, BLOCK);
    }
  }

  // Randstreifen ausserhalb der vollen Bloecke sind unveraendert.
  ctx.drawImage(zwischen, 0, 0);
  // Stufe 1 rueckwaerts: zurueckdrehen und an die eigene Stelle setzen. Der
  // Server drehte gegen den Uhrzeigersinn; `rotate` dreht im Uhrzeigersinn.
  const p = vertauschung(n, seed);
  for (let k = 0; k < n; k++) {
    const q = p[k];
    const [drehung] = formen[k];
    ctx.save();
    ctx.translate((q % spalten) * BLOCK + BLOCK / 2, Math.floor(q / spalten) * BLOCK + BLOCK / 2);
    ctx.rotate((drehung * Math.PI) / 2);
    ctx.drawImage(
      zwischen,
      (k % spalten) * BLOCK,
      Math.floor(k / spalten) * BLOCK,
      BLOCK,
      BLOCK,
      -BLOCK / 2,
      -BLOCK / 2,
      BLOCK,
      BLOCK,
    );
    ctx.restore();
  }
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
 * Einmal-Tickets fuer Kacheln und Bilder. Das Gateway nimmt jedes Ticket nur
 * einmal an (`tile-service/main.py`, `require_ticket`, Kopf `X-Req`); eine nachgeschickte
 * Anfrage mit demselben Ticket bekommt 403. Der Vorrat wird in Buendeln
 * nachgefuellt, bevor er leer ist.
 */
export class TicketVorrat {
  private vorrat: string[] = [];
  private laden: Promise<void> | null = null;

  constructor(
    private sessionToken: string,
    private issueId: string,
  ) {}

  private nachfuellen(): Promise<void> {
    this.laden ??= fetch(`${TILE_SERVICE_URL}/api/issue/${this.issueId}/n`, {
      headers: { "X-Tile-Session": this.sessionToken },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Tickets ${res.status}`);
        this.vorrat.push(...((await res.json()).t as string[]));
      })
      .finally(() => {
        this.laden = null;
      });
    return this.laden;
  }

  async ticket(): Promise<string> {
    while (this.vorrat.length === 0) await this.nachfuellen();
    const t = this.vorrat.shift()!;
    if (this.vorrat.length < 16) void this.nachfuellen().catch(() => undefined);
    return t;
  }
}

const vorraete = new Map<string, TicketVorrat>();

/** Ein Vorrat je Lesesitzung; Kacheln und Bilder teilen ihn. */
export function ticketVorrat(sessionToken: string, issueId: string): TicketVorrat {
  let v = vorraete.get(sessionToken);
  if (!v) {
    v = new TicketVorrat(sessionToken, issueId);
    vorraete.set(sessionToken, v);
  }
  return v;
}

/** Anfrage an das Gateway mit Sitzung und frischem Ticket. */
export async function mitTicket(
  url: string,
  sessionToken: string,
  issueId: string,
  signal: AbortSignal,
): Promise<Response> {
  const ticket = await ticketVorrat(sessionToken, issueId).ticket();
  return fetch(url, {
    headers: { "X-Tile-Session": sessionToken, "X-Req": ticket },
    signal,
  });
}

/**
 * Artikelbild ueber die Sitzung holen und auf eine Zeichenflaeche setzen. Es
 * gibt keine Bildadresse, auch kein `blob:`: Bildlupen wie Imagus und
 * "Bild speichern" finden nichts.
 */
export async function bildAlsCanvas(
  url: string,
  sessionToken: string,
  issueId: string,
  k: number,
  signal: AbortSignal,
): Promise<HTMLCanvasElement> {
  const res = await mitTicket(url, sessionToken, issueId, signal);
  if (!res.ok) throw new Error(`Bild ${res.status}`);
  const bild = await createImageBitmap(await res.blob());
  const assetId = /\/api\/asset\/([^/?.]+)\.jpg/.exec(url)?.[1];
  if (res.headers.get("X-V") === "1" && assetId) {
    return zusammensetzen(bild, fnv1a32(`${k}:asset:${assetId}`));
  }
  const canvas = document.createElement("canvas");
  canvas.width = bild.width;
  canvas.height = bild.height;
  canvas.getContext("2d")!.drawImage(bild, 0, 0);
  bild.close();
  return canvas;
}

/** Leseschriften der Sitzung. Ihre Zeichentabelle passt nur zu deren Text. */
export const SCHUTZ_SCHRIFTEN = [
  { datei: "0", familie: "F0", style: "normal", weight: "300 800" },
  { datei: "1", familie: "F1", style: "normal", weight: "400 900" },
  { datei: "2", familie: "F1", style: "italic", weight: "400 900" },
] as const;

export async function schriftenLaden(
  sessionToken: string,
  issueId: string,
  signal: AbortSignal,
): Promise<FontFace[]> {
  return Promise.all(
    SCHUTZ_SCHRIFTEN.map(async (s) => {
      const res = await fetch(`${TILE_SERVICE_URL}/api/issue/${issueId}/f/${s.datei}`, {
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
