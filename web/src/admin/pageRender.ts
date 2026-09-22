/**
 * Druckseiten im Browser rendern.
 *
 * Bisher ging das ganze Innenteil-PDF auf den Server, nur damit dort jede
 * Seite als JPEG gerendert wird. Das sind hundertvierzig Megabyte fuer ein
 * Ergebnis, das der Browser genauso gut herstellen kann: die Schriften stecken
 * im PDF, pdf.js benutzt sie.
 *
 * Geschnitten wird auf das Netzformat. Druckdaten tragen ringsum Anschnitt und
 * Schnittmarken; im Reader haben sie nichts zu suchen, und der Satz rechnet
 * ohnehin im Netzformat. Wie breit der Anschnitt ist, sagt der Vergleich mit
 * der Seitengroesse aus der Satzdatei — er liegt bei allen Heften mittig.
 */

import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export type RenderedPage = {
  /** 0-basiert, in der Reihenfolge der Quelldatei. */
  sourcePageIndex: number;
  blob: Blob;
  width: number;
  height: number;
};

export type RenderOptions = {
  /** Breite des Ergebnisses in Bildpunkten. */
  targetWidth: number;
  quality: number;
  /** Netzformat aus der Satzdatei, in Punkt. Fehlt es, bleibt der Anschnitt. */
  trimWidthPt?: number;
  trimHeightPt?: number;
  /** Nur diese Haelfte der Quellseite rendern (Umschlagboegen). */
  half?: "left" | "right";
};

function canvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

async function toJpeg(
  c: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  if ("convertToBlob" in c) return await c.convertToBlob({ type: "image/jpeg", quality });
  return await new Promise<Blob>((resolve, reject) =>
    (c as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("JPEG-Kodierung fehlgeschlagen"))),
      "image/jpeg",
      quality,
    ),
  );
}

/**
 * Wie viel ringsum abzuschneiden ist, damit vom Druckbogen das Netzformat
 * uebrig bleibt. Der Anschnitt liegt mittig, deshalb je Seite die Haelfte der
 * Differenz.
 */
export function anschnitt(
  seiteBreitePt: number,
  seiteHoehePt: number,
  netzBreitePt?: number,
  netzHoehePt?: number,
): { links: number; oben: number; breite: number; hoehe: number } {
  if (!netzBreitePt || !netzHoehePt) {
    return { links: 0, oben: 0, breite: seiteBreitePt, hoehe: seiteHoehePt };
  }
  const breite = Math.min(seiteBreitePt, netzBreitePt);
  const hoehe = Math.min(seiteHoehePt, netzHoehePt);
  return {
    links: Math.max(0, (seiteBreitePt - breite) / 2),
    oben: Math.max(0, (seiteHoehePt - hoehe) / 2),
    breite,
    hoehe,
  };
}

/** Seitenzahl eines PDF, ohne es zu rendern. */
export async function pdfPageCount(file: Blob): Promise<number> {
  const daten = new Uint8Array(await file.arrayBuffer());
  const auftrag = pdfjs.getDocument({ data: daten });
  const doc = await auftrag.promise;
  const n = doc.numPages;
  await auftrag.destroy();
  return n;
}

/**
 * Alle Seiten eines PDF rendern und einzeln herausgeben.
 *
 * Die Seiten kommen nacheinander durch `onPage`, damit der Aufrufer jede
 * gleich hochladen kann und nie ein ganzes Heft im Speicher liegt.
 */
export async function renderPdfPages(
  file: Blob,
  options: RenderOptions,
  onPage: (page: RenderedPage, index: number, total: number) => Promise<void>,
  abgebrochen?: () => boolean,
): Promise<number> {
  const daten = new Uint8Array(await file.arrayBuffer());
  const auftrag = pdfjs.getDocument({ data: daten });
  const doc = await auftrag.promise;
  try {
    for (let i = 0; i < doc.numPages; i++) {
      if (abgebrochen?.()) break;
      const page = await doc.getPage(i + 1);
      const roh = page.getViewport({ scale: 1 });
      const schnitt = anschnitt(
        roh.width,
        roh.height,
        options.trimWidthPt,
        options.trimHeightPt,
      );
      const scale = options.targetWidth / schnitt.breite;
      const viewport = page.getViewport({ scale });
      const breite = Math.round(schnitt.breite * scale);
      const hoehe = Math.round(schnitt.hoehe * scale);

      const c = canvas(breite, hoehe);
      const ctx = (c as HTMLCanvasElement).getContext("2d", {
        alpha: false,
      }) as CanvasRenderingContext2D;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, breite, hoehe);
      // Der Anschnitt wird nicht gerendert, sondern weggeschoben.
      ctx.translate(-schnitt.links * scale, -schnitt.oben * scale);
      await page.render({ canvasContext: ctx, viewport, canvas: c as HTMLCanvasElement })
        .promise;
      page.cleanup();

      const blob = await toJpeg(c, options.quality);
      await onPage(
        { sourcePageIndex: i, blob, width: breite, height: hoehe },
        i,
        doc.numPages,
      );
    }
    return doc.numPages;
  } finally {
    await auftrag.destroy();
  }
}

/**
 * Den Einzelpreis aus dem Impressum lesen.
 *
 * Er steht im Innenteil als Text ("Einzelheft: 9,80"), meist auf einer der
 * letzten Seiten. Seit die Druckdatei nicht mehr auf den Server geht, ist der
 * Browser der einzige Ort, an dem er zu holen ist — und der genauere: auf der
 * Titelseite steht derselbe Preis nur als Bild, und die Texterkennung
 * verwechselt dort Ziffern.
 *
 * Das Eurozeichen kommt je nach Datei als "t", "E" oder "€" heraus, weil es in
 * einer Symbolschrift gesetzt ist.
 */
const PREIS = /Einzel(?:heft|preis|verkaufspreis)\s*:?\s*(?:[€teE]\s*)?(\d{1,3})[,.](\d{2})\s*(?:[€teE])?/i;
/** So viele Seiten vom Ende her werden durchsucht. */
const IMPRESSUM_SEITEN = 6;

export async function readPriceFromImprint(file: Blob): Promise<number | undefined> {
  const daten = new Uint8Array(await file.arrayBuffer());
  const auftrag = pdfjs.getDocument({ data: daten });
  const doc = await auftrag.promise;
  try {
    const ab = Math.max(1, doc.numPages - IMPRESSUM_SEITEN + 1);
    for (let n = doc.numPages; n >= ab; n--) {
      const page = await doc.getPage(n);
      const inhalt = await page.getTextContent();
      const text = inhalt.items
        .map((i) => ("str" in i ? i.str : ""))
        .join(" ")
        .replace(/\s+/g, " ");
      page.cleanup();
      const treffer = PREIS.exec(text);
      if (treffer) {
        const euro = Number(treffer[1]);
        const cent = Number(treffer[2]);
        // Ein Heft unter einem Euro oder ueber zweihundert ist kein Preis,
        // sondern ein Lesefehler.
        if (euro >= 1 && euro <= 200) return euro * 100 + cent;
      }
    }
    return undefined;
  } finally {
    await auftrag.destroy();
  }
}
