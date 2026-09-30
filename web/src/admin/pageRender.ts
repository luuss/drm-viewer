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
import { normiereTextelemente, type TextItem, type TextPage } from "./textLayer";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export type RenderedPage = {
  /** 0-basiert, in der Reihenfolge der Quelldatei. */
  sourcePageIndex: number;
  blob: Blob;
  width: number;
  height: number;
  /** Die Textebene der Seite, wenn `mitText` gesetzt war. */
  text?: TextItem[];
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
  /** Die Textebene der Seite mitlesen (fuer das gedruckte Inhaltsverzeichnis). */
  mitText?: boolean;
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

/**
 * Ein geoeffnetes PDF. Der Import liest aus dem Innenteil erst den Preis und
 * rendert dann die Seiten; frueher wurde die Druckdatei dafuer zweimal
 * eingelesen und zweimal zerlegt — bei hundertvierzig Megabyte vom Stick
 * spuerbar.
 */
export type OffenesPdf = {
  doc: pdfjs.PDFDocumentProxy;
  /** Die Datei dahinter: weitere Spuren oeffnen sie noch einmal. */
  datei: Blob;
  schliessen: () => Promise<void>;
};

export async function oeffnePdf(file: Blob): Promise<OffenesPdf> {
  const daten = new Uint8Array(await file.arrayBuffer());
  const auftrag = pdfjs.getDocument({ data: daten });
  const doc = await auftrag.promise;
  return { doc, datei: file, schliessen: () => auftrag.destroy() };
}

/**
 * Wie viele Seiten gleichzeitig gerendert werden. Jede Spur hat ihr eigenes
 * Dokument und damit ihren eigenen pdf.js-Faden: der zerlegt die Seite,
 * waehrend der Hauptfaden die vorige malt. Gemessen an DMZ-Zeitgeschichte 80
 * wartete eine einzelne Spur nur 6 von 93 Sekunden auf die Leitung — der
 * Rechner war der Engpass. Jede Spur haelt die Druckdatei einmal im Speicher.
 */
export const RENDER_SPUREN = (() => {
  if (typeof navigator === "undefined") return 1;
  const kerne = navigator.hardwareConcurrency ?? 0;
  return kerne >= 8 ? 3 : kerne >= 4 ? 2 : 1;
})();

/** Eine Datei oeffnen oder ein schon offenes PDF benutzen; nur Eigenes wird geschlossen. */
async function mitPdf<T>(
  quelle: Blob | OffenesPdf,
  arbeit: (doc: pdfjs.PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  if ("doc" in quelle) return await arbeit(quelle.doc);
  const offen = await oeffnePdf(quelle);
  try {
    return await arbeit(offen.doc);
  } finally {
    await offen.schliessen();
  }
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
async function renderSeite(
  doc: pdfjs.PDFDocumentProxy,
  i: number,
  options: RenderOptions,
): Promise<RenderedPage> {
  const page = await doc.getPage(i + 1);
  const roh = page.getViewport({ scale: 1 });
  const schnitt = anschnitt(roh.width, roh.height, options.trimWidthPt, options.trimHeightPt);
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
  await page.render({ canvasContext: ctx, viewport, canvas: c as HTMLCanvasElement }).promise;
  // Die Textebene kommt aus demselben Seitenobjekt, in Punkt und ungedreht
  // (`roh`), damit derselbe Schnitt gilt wie fuers Bild.
  const text = options.mitText
    ? normiereTextelemente((await page.getTextContent()).items as any[], roh, schnitt)
    : undefined;
  page.cleanup();

  const blob = await toJpeg(c, options.quality);
  return {
    sourcePageIndex: i,
    blob,
    width: breite,
    height: hoehe,
    ...(text ? { text } : {}),
  };
}

/**
 * Nur die Textebene eines Innenteils lesen, ohne die Seiten zu rendern.
 *
 * Fuer Hefte, die vor der Textebene importiert wurden: die Druckdatei bleibt
 * auf dem Rechner, hoch geht nur die Liste der Zeilen mit ihren Rechtecken.
 * Geschnitten wird auf dasselbe Netzformat wie beim Rendern, sonst laegen
 * Textebene und Seitenbild gegeneinander verschoben.
 */
export async function textebeneAusPdf(
  quelle: Blob | OffenesPdf,
  netz?: { pageWidthPt: number; pageHeightPt: number },
  onPage?: (n: number, total: number) => void,
): Promise<TextPage[]> {
  return await mitPdf(quelle, async (doc) => {
    const out: TextPage[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const roh = page.getViewport({ scale: 1 });
      const schnitt = anschnitt(roh.width, roh.height, netz?.pageWidthPt, netz?.pageHeightPt);
      const inhalt = await page.getTextContent();
      out.push({
        sourcePageIndex: i,
        items: normiereTextelemente(inhalt.items as any[], roh, schnitt),
      });
      page.cleanup();
      onPage?.(i + 1, doc.numPages);
    }
    return out;
  });
}

/**
 * Alle Seiten eines PDF rendern und einzeln herausgeben.
 *
 * Die Seiten kommen durch `onPage`, damit der Aufrufer jede gleich hochladen
 * kann und nie ein ganzes Heft im Speicher liegt. Mit mehreren Spuren kommen
 * sie nicht streng der Reihe nach — der Index sagt, wohin sie gehoeren.
 */
export async function renderPdfPages(
  quelle: Blob | OffenesPdf,
  options: RenderOptions & { spuren?: number },
  onPage: (page: RenderedPage, index: number, total: number) => Promise<void>,
  abgebrochen?: () => boolean,
): Promise<number> {
  return await mitPdf(quelle, async (doc) => {
    const total = doc.numPages;
    const datei = "doc" in quelle ? quelle.datei : quelle;
    const spuren = Math.max(1, Math.min(options.spuren ?? 1, total));
    let naechste = 0;
    let fehler = false;

    async function spur(eigenes: pdfjs.PDFDocumentProxy) {
      while (!fehler && !abgebrochen?.()) {
        const i = naechste++;
        if (i >= total) return;
        try {
          const seite = await renderSeite(eigenes, i, options);
          await onPage(seite, i, total);
        } catch (e) {
          fehler = true;
          throw e;
        }
      }
    }

    // Die erste Spur nimmt das schon offene Dokument, jede weitere oeffnet
    // die Datei selbst.
    const weitere: OffenesPdf[] = [];
    try {
      const laeufe = [spur(doc)];
      for (let k = 1; k < spuren; k++) {
        laeufe.push(
          oeffnePdf(datei).then((offen) => {
            weitere.push(offen);
            return spur(offen.doc);
          }),
        );
      }
      const ergebnisse = await Promise.allSettled(laeufe);
      const kaputt = ergebnisse.find((r) => r.status === "rejected");
      if (kaputt) throw (kaputt as PromiseRejectedResult).reason;
    } finally {
      await Promise.all(weitere.map((w) => w.schliessen().catch(() => {})));
    }
    return total;
  });
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

export async function readPriceFromImprint(
  quelle: Blob | OffenesPdf,
): Promise<number | undefined> {
  return await mitPdf(quelle, async (doc) => {
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
  });
}
