/**
 * Hintergrundfaden fuer die Bildumwandlung.
 *
 * Ein Heft bringt ueber siebzig Bilder in Druckaufloesung mit. Im Hauptfaden
 * umgewandelt, stuende die Oberflaeche waehrend des ganzen Imports. Deshalb
 * laeuft die Umwandlung hier, ein Bild nach dem anderen.
 */

import { convertImage } from "./imageConvert";

export type ConvertRequest = {
  id: number;
  file: File | Blob;
  name: string;
  maxEdge: number;
  quality: number;
};

export type ConvertResponse =
  | {
      id: number;
      ok: true;
      blob: Blob;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
    }
  | { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  const { id, file, name, maxEdge, quality } = event.data;
  try {
    const bild = await convertImage(file, name, { maxEdge, quality });
    const antwort: ConvertResponse = {
      id,
      ok: true,
      blob: bild.blob,
      width: bild.width,
      height: bild.height,
      sourceWidth: bild.sourceWidth,
      sourceHeight: bild.sourceHeight,
    };
    self.postMessage(antwort);
  } catch (e: unknown) {
    const text = e instanceof Error ? e.message : String(e);
    self.postMessage({ id, ok: false, error: text } satisfies ConvertResponse);
  }
};
