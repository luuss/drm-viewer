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
import { mitWiederholung } from "./nachladen";
import { beimPufferLeeren, type Paket } from "./puffer";
import { liveAnfrage } from "./vorrang";

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
 * So lange nach dem Holen gilt ein Ticket hier als frisch. Das Gateway nimmt
 * es zehn Minuten lang an (`TICKET_TTL`); die Spanne davor deckt Uhren und
 * Wege ab. Aeltere Tickets fliegen vor der Ausgabe aus dem Vorrat: nach einer
 * Lesepause bekamen sonst die naechsten Kacheln und Bilder 403.
 */
const TICKET_FRISCH_MS = 8 * 60 * 1000;

/**
 * Einmal-Tickets fuer Kacheln und Bilder. Das Gateway nimmt jedes Ticket nur
 * einmal an (`tile-service/main.py`, `require_ticket`, Kopf `X-Req`); eine nachgeschickte
 * Anfrage mit demselben Ticket bekommt 403. Der Vorrat wird in Buendeln
 * nachgefuellt, bevor er leer ist.
 */
export class TicketVorrat {
  private vorrat: { t: string; bis: number }[] = [];
  private laden: Promise<void> | null = null;

  constructor(
    private sessionToken: string,
    private issueId: string,
    private jetzt: () => number = Date.now,
  ) {}

  private nachfuellen(): Promise<void> {
    this.laden ??= fetch(`${TILE_SERVICE_URL}/api/issue/${this.issueId}/n`, {
      headers: { "X-Tile-Session": this.sessionToken },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Tickets ${res.status}`);
        const bis = this.jetzt() + TICKET_FRISCH_MS;
        this.vorrat.push(...((await res.json()).t as string[]).map((t) => ({ t, bis })));
      })
      .finally(() => {
        this.laden = null;
      });
    return this.laden;
  }

  private abgelaufeneWeg() {
    const jetzt = this.jetzt();
    const frisch = this.vorrat.findIndex((e) => e.bis > jetzt);
    this.vorrat.splice(0, frisch < 0 ? this.vorrat.length : frisch);
  }

  /**
   * Vorrat schon fuellen, bevor das erste Bild ihn braucht: der Artikel
   * oeffnet, und die Bilder warten nicht noch auf das Buendel.
   */
  vorbereiten() {
    this.abgelaufeneWeg();
    if (this.vorrat.length < 16) void this.nachfuellen().catch(() => undefined);
  }

  async ticket(): Promise<string> {
    this.abgelaufeneWeg();
    while (this.vorrat.length === 0) {
      await this.nachfuellen();
      this.abgelaufeneWeg();
    }
    const { t } = this.vorrat.shift()!;
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

/** Kopf fuer Anfragen des Offline-Puffers: das Gateway stellt sie hinten an. */
export const NEBENHER = { "X-Q": "1" } as const;

/**
 * Anfrage an das Gateway mit Sitzung und frischem Ticket. `nebenher`: fuer
 * den Offline-Puffer, nicht fuer die Anzeige (`tile-service/main.py`,
 * `puffer_spur`).
 */
export async function mitTicket(
  url: string,
  sessionToken: string,
  issueId: string,
  signal: AbortSignal,
  nebenher = false,
): Promise<Response> {
  const ticket = await ticketVorrat(sessionToken, issueId).ticket();
  return fetch(url, {
    headers: {
      "X-Tile-Session": sessionToken,
      "X-Req": ticket,
      ...(nebenher ? NEBENHER : {}),
    },
    signal,
  });
}

/** Ohne Verbindung und nicht im Puffer: daran erkennt der Reader den Fall. */
export const OHNE_NETZ = "ohne-netz";

/** Ein geholtes Bild auf eine Zeichenflaeche, verwuerfelt oder nicht. */
async function aufFlaeche(daten: Blob, seed: number | null): Promise<HTMLCanvasElement> {
  const bild = await createImageBitmap(daten);
  if (seed !== null) return zusammensetzen(bild, seed);
  const canvas = document.createElement("canvas");
  canvas.width = bild.width;
  canvas.height = bild.height;
  canvas.getContext("2d")!.drawImage(bild, 0, 0);
  bild.close();
  return canvas;
}

/**
 * Artikelbild auf eine Zeichenflaeche setzen. Es gibt keine Bildadresse,
 * auch kein `blob:`: Bildlupen wie Imagus und "Bild speichern" finden nichts.
 *
 * Liegt das Bild im Offline-Puffer (`puffer.ts`), kommt es von dort, samt
 * dem Schluessel der Sitzung, mit der es geholt wurde. Sonst ueber die
 * Sitzung vom Gateway, und es wandert gleich in den Puffer.
 */
export async function bildAlsCanvas(
  url: string,
  sessionToken: string | null,
  issueId: string,
  k: number | null,
  signal: AbortSignal,
  puffer?: { paket: Paket | null; stand: string | null },
): Promise<HTMLCanvasElement> {
  const assetId = /\/api\/asset\/([^/?.]+)\.jpg/.exec(url)?.[1];
  const stand = puffer?.stand ?? "";
  const paket = puffer?.paket ?? null;
  if (paket && assetId) {
    const da = await paket.bild(assetId, stand).catch(() => null);
    if (da) {
      return aufFlaeche(
        new Blob([da.daten]),
        da.verwuerfelt ? fnv1a32(`${da.k}:asset:${assetId}`) : null,
      );
    }
  }
  if (!sessionToken || k === null) throw new Error(OHNE_NETZ);
  // Gebremst (429) oder ein Serverfehler: von selbst noch einmal, je Versuch
  // mit frischem Ticket.
  const res = await liveAnfrage(
    mitWiederholung(() => mitTicket(url, sessionToken, issueId, signal), signal),
  );
  if (!res.ok) throw new Error(`Bild ${res.status}`);
  const daten = await res.arrayBuffer();
  const verwuerfelt = res.headers.get("X-V") === "1" && !!assetId;
  if (paket && assetId) {
    void paket.bildAblegen(assetId, stand, k, verwuerfelt, daten).catch(() => undefined);
  }
  return aufFlaeche(new Blob([daten]), verwuerfelt ? fnv1a32(`${k}:asset:${assetId}`) : null);
}

/** Leseschriften der Sitzung. Ihre Zeichentabelle passt nur zu deren Text. */
export const SCHUTZ_SCHRIFTEN = [
  { datei: "0", familie: "F0", style: "normal", weight: "300 800" },
  { datei: "1", familie: "F1", style: "normal", weight: "400 900" },
  { datei: "2", familie: "F1", style: "italic", weight: "400 900" },
] as const;

/**
 * Familiennamen der Leseschriften eines Satzes. Jede Lesesitzung hat ihre
 * eigenen: ein Text aus dem Puffer kann von einer frueheren Sitzung stammen
 * und steht dann neben der Schrift der laufenden.
 */
export function schriftFamilien(satz: string) {
  return { f0: `F0${satz.slice(0, 6)}`, f1: `F1${satz.slice(0, 6)}` };
}

/** Schriftdateien je Satz, einmal geholt. */
const schriftDaten = new Map<string, Promise<ArrayBuffer[]>>();
beimPufferLeeren(() => schriftDaten.clear());

async function schriftenVomGateway(sessionToken: string, issueId: string): Promise<ArrayBuffer[]> {
  return Promise.all(
    SCHUTZ_SCHRIFTEN.map(async (s) => {
      const res = await fetch(`${TILE_SERVICE_URL}/api/issue/${issueId}/f/${s.datei}`, {
        headers: { "X-Tile-Session": sessionToken },
      });
      if (!res.ok) throw new Error(`Schrift ${res.status}`);
      return res.arrayBuffer();
    }),
  );
}

/** Welche Saetze schon in welchem Paket liegen. */
const abgelegt = new WeakMap<Paket, Set<string>>();

async function insPaket(paket: Paket, satz: string, daten: ArrayBuffer[]) {
  const schon = abgelegt.get(paket) ?? new Set<string>();
  abgelegt.set(paket, schon);
  if (schon.has(satz)) return;
  schon.add(satz);
  await Promise.all(
    daten.map(async (d, nr) => {
      if (!(await paket.schrift(satz, nr).catch(() => null))) {
        await paket.schriftAblegen(satz, nr, d).catch(() => undefined);
      }
    }),
  );
}

/**
 * Die drei Schriftdateien eines Satzes: aus dem Puffer, sonst vom Gateway,
 * solange es die laufende Sitzung ist. Was das Paket noch nicht hat, landet
 * darin, auch wenn es aus dem Speicher kam.
 */
export async function satzSchriften(
  satz: string,
  quelle: {
    paket: Paket | null;
    issueId: string;
    /** Laufende Sitzung und ihr Satz; ohne Verbindung leer. */
    sessionToken: string | null;
    liveSatz: string | null;
  },
): Promise<ArrayBuffer[]> {
  let laden = schriftDaten.get(satz);
  if (!laden) {
    const { paket } = quelle;
    const neu = (async () => {
      if (paket) {
        const da = await Promise.all(
          SCHUTZ_SCHRIFTEN.map((_, nr) => paket.schrift(satz, nr).catch(() => null)),
        );
        if (da.every((d): d is ArrayBuffer => d !== null)) return da;
      }
      if (!quelle.sessionToken || satz !== quelle.liveSatz) throw new Error(OHNE_NETZ);
      return schriftenVomGateway(quelle.sessionToken, quelle.issueId);
    })();
    schriftDaten.set(satz, neu);
    neu.catch(() => {
      if (schriftDaten.get(satz) === neu) schriftDaten.delete(satz);
    });
    laden = neu;
  }
  const daten = await laden;
  if (quelle.paket) await insPaket(quelle.paket, satz, daten);
  return daten;
}

/** Schriften eines Satzes unter dessen Familiennamen bereitstellen. */
export async function schriftenAnmelden(satz: string, daten: ArrayBuffer[]): Promise<FontFace[]> {
  const namen = schriftFamilien(satz);
  return Promise.all(
    SCHUTZ_SCHRIFTEN.map(async (s, nr) => {
      const face = new FontFace(s.familie === "F0" ? namen.f0 : namen.f1, daten[nr].slice(0), {
        style: s.style,
        weight: s.weight,
        display: "block",
      });
      await face.load();
      return face;
    }),
  );
}
