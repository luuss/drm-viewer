/**
 * Zugang zu den Umwandlungsfaeden.
 *
 * Ein Bild in Druckaufloesung belegt waehrend der Umwandlung mehrere hundert
 * Megabyte. Deshalb laeuft nicht jedes Bild fuer sich, sondern eine kleine
 * feste Zahl von Faeden nebeneinander: genug, um mehrere Kerne zu nutzen,
 * wenig genug, dass der Speicher reicht. Ein Heft bringt bis zu 250 Bilder
 * mit; nacheinander gerechnet ist das die laengste Strecke des Imports.
 */

import { convertImage, type ConvertedImage } from "./imageConvert";
import type { ConvertResponse } from "./convertWorker";

/** Zwei Faeden sind der Kompromiss aus Tempo und Speicher. */
export const FAEDEN = 2;

type Auftrag = {
  file: File | Blob;
  name: string;
  maxEdge: number;
  quality: number;
  resolve: (v: ConvertedImage) => void;
  reject: (e: Error) => void;
};

type Faden = {
  worker: Worker;
  /** Auftrag, auf den dieser Faden gerade antwortet. */
  laufend: Auftrag | null;
  id: number;
};

export class ImageConverter {
  private faeden: Faden[] = [];
  private wartend: Auftrag[] = [];
  private zaehler = 0;
  private ohneFaden = false;

  constructor(private readonly breite = FAEDEN) {}

  /** Ein Bild umwandeln. */
  convert(
    file: File | Blob,
    name: string,
    maxEdge: number,
    quality: number,
  ): Promise<ConvertedImage> {
    return new Promise<ConvertedImage>((resolve, reject) => {
      this.wartend.push({ file, name, maxEdge, quality, resolve, reject });
      this.weiter();
    });
  }

  private weiter(): void {
    while (this.wartend.length > 0) {
      const faden = this.freierFaden();
      if (!faden) return;
      const auftrag = this.wartend.shift()!;
      if (faden === "hauptfaden") {
        // Kein Worker verfuegbar: im Hauptfaden rechnen. Langsamer, aber der
        // Import bricht nicht ab.
        convertImage(auftrag.file, auftrag.name, {
          maxEdge: auftrag.maxEdge,
          quality: auftrag.quality,
        }).then(auftrag.resolve, auftrag.reject);
        continue;
      }
      faden.laufend = auftrag;
      faden.id += 1;
      faden.worker.postMessage({
        id: faden.id,
        file: auftrag.file,
        name: auftrag.name,
        maxEdge: auftrag.maxEdge,
        quality: auftrag.quality,
      });
    }
  }

  private freierFaden(): Faden | "hauptfaden" | null {
    const frei = this.faeden.find((f) => f.laufend === null);
    if (frei) return frei;
    if (this.faeden.length < this.breite && !this.ohneFaden) {
      const neu = this.baue();
      if (neu) return neu;
      // Faeden gibt es hier nicht (aelterer Browser, Testumgebung).
      this.ohneFaden = true;
      return "hauptfaden";
    }
    return this.ohneFaden ? "hauptfaden" : null;
  }

  private baue(): Faden | null {
    if (typeof Worker === "undefined") return null;
    try {
      const worker = new Worker(new URL("./convertWorker.ts", import.meta.url), {
        type: "module",
      });
      const faden: Faden = { worker, laufend: null, id: 0 };
      worker.onmessage = (event: MessageEvent<ConvertResponse>) => {
        const auftrag = faden.laufend;
        if (!auftrag || event.data.id !== faden.id) return;
        faden.laufend = null;
        const antwort = event.data;
        if (antwort.ok) {
          auftrag.resolve({
            blob: antwort.blob,
            width: antwort.width,
            height: antwort.height,
            sourceWidth: antwort.sourceWidth,
            sourceHeight: antwort.sourceHeight,
          });
        } else {
          auftrag.reject(new Error(antwort.error));
        }
        this.weiter();
      };
      worker.onerror = () => {
        // Faellt ein Faden aus, geht sein Auftrag in den Hauptfaden und der
        // Faden wird nicht wieder benutzt.
        const auftrag = faden.laufend;
        faden.laufend = null;
        this.faeden = this.faeden.filter((f) => f !== faden);
        if (this.faeden.length === 0) this.ohneFaden = true;
        if (auftrag) this.wartend.unshift(auftrag);
        this.weiter();
      };
      this.faeden.push(faden);
      return faden;
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const faden of this.faeden) faden.worker.terminate();
    this.faeden = [];
    for (const auftrag of this.wartend) {
      auftrag.reject(new Error("Umwandlung abgebrochen"));
    }
    this.wartend = [];
  }
}
