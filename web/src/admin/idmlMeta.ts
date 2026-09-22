/**
 * Die Satzdatei im Browser anlesen.
 *
 * Gebraucht wird daraus nur das Netzformat: die Groesse einer Seite in Punkt,
 * so wie der Satz sie kennt. Das Druck-PDF ist groesser — es traegt ringsum
 * den Anschnitt. Wer beides kennt, kann die Seite beim Rendern auf das
 * Netzformat schneiden, und dann decken sich Satz und Seitenbild.
 *
 * Eine IDML ist ein ZIP mit XML darin; beides kann der Browser.
 */

import JSZip from "jszip";

export type IdmlMeta = {
  /** Breite einer Seite im Netzformat, in Punkt (72 pro Zoll). */
  pageWidthPt: number;
  pageHeightPt: number;
  /** Zahl der Seiten im Satz — zum Abgleich mit dem PDF. */
  pageCount: number;
};

function zahl(wert: string | null | undefined): number[] {
  return (wert ?? "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

export async function readIdmlMeta(file: Blob): Promise<IdmlMeta | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    return null;
  }
  const bogen = Object.keys(zip.files).filter((n) => n.startsWith("Spreads/"));
  if (!bogen.length) return null;

  const parser = new DOMParser();
  let breite = 0;
  let hoehe = 0;
  let seiten = 0;

  for (const name of bogen) {
    let xml: Document;
    try {
      xml = parser.parseFromString(await zip.files[name].async("text"), "text/xml");
    } catch {
      continue;
    }
    for (const page of Array.from(xml.getElementsByTagName("Page"))) {
      const bounds = zahl(page.getAttribute("GeometricBounds"));
      if (bounds.length !== 4) continue;
      const [oben, links, unten, rechts] = bounds;
      seiten += 1;
      // Alle Seiten eines Hefts haben dasselbe Format; die groesste gewinnt,
      // falls eine Ausklappseite dazwischensteht.
      breite = Math.max(breite, Math.abs(rechts - links));
      hoehe = Math.max(hoehe, Math.abs(unten - oben));
    }
  }
  if (!seiten || breite <= 0 || hoehe <= 0) return null;
  return { pageWidthPt: breite, pageHeightPt: hoehe, pageCount: seiten };
}
