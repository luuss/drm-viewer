/**
 * Bilder im Browser umwandeln.
 *
 * Die Druckvorstufe liefert CMYK-TIFF in Druckaufloesung — ein einzelnes Heft
 * bringt so ueber ein Gigabyte mit. Fuer das Lesen im Netz braucht es davon
 * nichts: ein JPEG in Bildschirmgroesse reicht. Umgewandelt wird deshalb hier,
 * bevor etwas den Rechner verlaesst, und hochgeladen wird nur das Ergebnis.
 *
 * TIFF kann kein Browser von sich aus. UTIF liest die in der Druckvorstufe
 * ueblichen Faelle (LZW, PackBits, unkomprimiert) einschliesslich CMYK. Fuer
 * JPEG und PNG nimmt der Browser seinen eigenen Dekoder.
 */

import UTIF from "utif2";

// UTIF prueft im CMYK-Zweig auf `window.UDOC` und faellt ohne diesen Eintrag
// auf die einfache Umrechnung zurueck. Im Hintergrundfaden gibt es aber gar
// kein `window` — dann bricht jede CMYK-TIFF mit "window is not defined" ab.
// Genau diese Dateien liefert die Druckvorstufe, deshalb hier ein Platzhalter.
{
  const global = globalThis as Record<string, unknown>;
  if (typeof global.window === "undefined") global.window = global;
}

export type ConvertedImage = {
  blob: Blob;
  width: number;
  height: number;
  /** Groesse des Originals in Bildpunkten, vor dem Verkleinern. */
  sourceWidth: number;
  sourceHeight: number;
};

export type ConvertOptions = {
  /** Laengste Kante des Ergebnisses in Bildpunkten. */
  maxEdge: number;
  /** JPEG-Guete zwischen 0 und 1. */
  quality: number;
};

const TIFF_ENDUNGEN = [".tif", ".tiff"];

export function istTiff(name: string): boolean {
  const lower = name.toLowerCase();
  return TIFF_ENDUNGEN.some((e) => lower.endsWith(e));
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function canvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function context2d(c: Canvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (c as HTMLCanvasElement).getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Kein 2D-Kontext verfuegbar");
  return ctx as CanvasRenderingContext2D;
}

async function toJpeg(c: Canvas, quality: number): Promise<Blob> {
  if ("convertToBlob" in c) {
    return await c.convertToBlob({ type: "image/jpeg", quality });
  }
  return await new Promise<Blob>((resolve, reject) =>
    (c as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("JPEG-Kodierung fehlgeschlagen"))),
      "image/jpeg",
      quality,
    ),
  );
}

/** Zielgroesse: nie groesser als das Original, laengste Kante gedeckelt. */
export function zielGroesse(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const laengste = Math.max(width, height);
  if (laengste <= maxEdge) return { width, height };
  const faktor = maxEdge / laengste;
  return {
    width: Math.max(1, Math.round(width * faktor)),
    height: Math.max(1, Math.round(height * faktor)),
  };
}

/**
 * Schrittweise halbieren statt in einem Zug verkleinern. Ein Zwischenschritt
 * mittelt die Bildpunkte, ein einziger grosser Sprung wirft sie weg — bei
 * Rasterbildern aus dem Druck ist der Unterschied deutlich sichtbar.
 */
function verkleinern(
  quelle: Canvas | ImageBitmap,
  breite: number,
  hoehe: number,
  zielBreite: number,
  zielHoehe: number,
): Canvas {
  let aktuell: Canvas | ImageBitmap = quelle;
  let b = breite;
  let h = hoehe;
  while (b > zielBreite * 2 && h > zielHoehe * 2) {
    const nb = Math.max(zielBreite, Math.round(b / 2));
    const nh = Math.max(zielHoehe, Math.round(h / 2));
    const zwischen = canvas(nb, nh);
    const ctx = context2d(zwischen);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(aktuell as CanvasImageSource, 0, 0, nb, nh);
    aktuell = zwischen;
    b = nb;
    h = nh;
  }
  const ziel = canvas(zielBreite, zielHoehe);
  const ctx = context2d(ziel);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(aktuell as CanvasImageSource, 0, 0, zielBreite, zielHoehe);
  return ziel;
}

async function tiffToCanvas(
  daten: ArrayBuffer,
): Promise<{ c: Canvas; width: number; height: number }> {
  const ifds = UTIF.decode(daten);
  if (!ifds.length) throw new Error("Keine Bilddaten in der TIFF");
  // Eine mehrschichtige Photoshop-TIFF bringt die zusammengefuehrte Fassung
  // als ersten Eintrag mit; die weiteren sind Ebenen und werden uebergangen.
  const ifd = ifds[0];
  // Die Typen von utif2 kennen den dritten Parameter nicht; er wird fuer
  // mehrseitige Dateien gebraucht, in denen die Streifen gemeinsam liegen.
  (UTIF.decodeImage as (a: ArrayBuffer, b: unknown, c: unknown) => void)(daten, ifd, ifds);
  const rgba = UTIF.toRGBA8(ifd);
  const width = ifd.width;
  const height = ifd.height;
  if (!rgba || !rgba.length || !width || !height) {
    throw new Error("TIFF liess sich nicht dekodieren");
  }
  const c = canvas(width, height);
  const ctx = context2d(c);
  // Weisser Grund: JPEG kennt keine Transparenz, ein freigestelltes Bild
  // wuerde sonst auf Schwarz stehen.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const bild = new ImageData(new Uint8ClampedArray(rgba), width, height);
  const hilfs = canvas(width, height);
  const hctx = context2d(hilfs);
  hctx.putImageData(bild as ImageData, 0, 0);
  ctx.drawImage(hilfs as CanvasImageSource, 0, 0);
  return { c, width, height };
}

/**
 * Eine Bilddatei in ein JPEG passender Groesse umwandeln.
 *
 * Wirft, wenn das Format nicht lesbar ist. Der Aufrufer entscheidet dann, ob
 * die Datei uebergangen wird — ein einzelnes unlesbares Bild soll den Import
 * eines Hefts nicht anhalten.
 */
export async function convertImage(
  file: File | Blob,
  name: string,
  { maxEdge, quality }: ConvertOptions,
): Promise<ConvertedImage> {
  let quelle: Canvas | ImageBitmap;
  let sourceWidth: number;
  let sourceHeight: number;

  if (istTiff(name)) {
    const buf = await file.arrayBuffer();
    const { c, width, height } = await tiffToCanvas(buf);
    quelle = c;
    sourceWidth = width;
    sourceHeight = height;
  } else {
    const bitmap = await createImageBitmap(file as Blob);
    quelle = bitmap;
    sourceWidth = bitmap.width;
    sourceHeight = bitmap.height;
  }

  const ziel = zielGroesse(sourceWidth, sourceHeight, maxEdge);
  const gezeichnet = verkleinern(
    quelle,
    sourceWidth,
    sourceHeight,
    ziel.width,
    ziel.height,
  );
  const blob = await toJpeg(gezeichnet, quality);
  if ("close" in quelle && typeof quelle.close === "function") quelle.close();
  return {
    blob,
    width: ziel.width,
    height: ziel.height,
    sourceWidth,
    sourceHeight,
  };
}

/** Dateiname des Ergebnisses: derselbe Name, Endung `.jpg`. */
export function jpegName(name: string): string {
  return name.replace(/\.[^.]+$/, "") + ".jpg";
}
