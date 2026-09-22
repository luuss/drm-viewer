/**
 * Zugang zum Umwandlungsfaden. Haelt genau einen Worker und reicht die
 * Auftraege der Reihe nach hinein — ein Bild in Druckaufloesung belegt
 * waehrend der Umwandlung mehrere hundert Megabyte, mehrere gleichzeitig
 * bringen den Rechner in Bedraengnis.
 */

import { convertImage, type ConvertedImage } from "./imageConvert";
import type { ConvertResponse } from "./convertWorker";

export class ImageConverter {
  private worker: Worker | null = null;
  private zaehler = 0;
  private offen = new Map<
    number,
    { resolve: (v: ConvertedImage) => void; reject: (e: Error) => void }
  >();
  private kette: Promise<unknown> = Promise.resolve();

  private hole(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    try {
      this.worker = new Worker(new URL("./convertWorker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (event: MessageEvent<ConvertResponse>) => {
        const antwort = event.data;
        const wartend = this.offen.get(antwort.id);
        if (!wartend) return;
        this.offen.delete(antwort.id);
        if (antwort.ok) {
          wartend.resolve({
            blob: antwort.blob,
            width: antwort.width,
            height: antwort.height,
            sourceWidth: antwort.sourceWidth,
            sourceHeight: antwort.sourceHeight,
          });
        } else {
          wartend.reject(new Error(antwort.error));
        }
      };
      this.worker.onerror = () => {
        // Faellt der Faden aus, geht es im Hauptfaden weiter: langsamer,
        // aber der Import bricht nicht ab.
        for (const [, w] of this.offen) w.reject(new Error("Umwandlungsfaden ausgefallen"));
        this.offen.clear();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  /** Ein Bild umwandeln. Auftraege laufen nacheinander. */
  convert(
    file: File | Blob,
    name: string,
    maxEdge: number,
    quality: number,
  ): Promise<ConvertedImage> {
    const auftrag = () => this.starte(file, name, maxEdge, quality);
    const ergebnis = this.kette.then(auftrag, auftrag);
    // Die Kette darf an einem Fehler nicht zerreissen.
    this.kette = ergebnis.catch(() => undefined);
    return ergebnis;
  }

  private starte(
    file: File | Blob,
    name: string,
    maxEdge: number,
    quality: number,
  ): Promise<ConvertedImage> {
    const worker = this.hole();
    if (!worker) return convertImage(file, name, { maxEdge, quality });
    const id = ++this.zaehler;
    return new Promise<ConvertedImage>((resolve, reject) => {
      this.offen.set(id, { resolve, reject });
      worker.postMessage({ id, file, name, maxEdge, quality });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.offen.clear();
  }
}
