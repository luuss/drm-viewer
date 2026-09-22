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
  /**
   * Gedruckte Seitenzahl der ersten Seite, wie InDesign sie fuehrt. Der
   * Innenteil beginnt meist bei 3, weil Umschlag und Umschlaginnenseite die
   * ersten beiden sind — verlassen muss man sich darauf aber nicht.
   */
  firstPrintedPage: number | null;
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
  const parser = new DOMParser();
  const bogen = await bogenInReihenfolge(zip, parser);
  if (!bogen.length) return null;

  let breite = 0;
  let hoehe = 0;
  let seiten = 0;
  let ersteGedruckte: number | null = null;

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
      if (ersteGedruckte === null) {
        // InDesign fuehrt die gedruckte Zahl als Namen der Seite.
        const gedruckt = Number((page.getAttribute("Name") ?? "").trim());
        if (Number.isInteger(gedruckt) && gedruckt > 0) ersteGedruckte = gedruckt;
      }
      seiten += 1;
      // Alle Seiten eines Hefts haben dasselbe Format; die groesste gewinnt,
      // falls eine Ausklappseite dazwischensteht.
      breite = Math.max(breite, Math.abs(rechts - links));
      hoehe = Math.max(hoehe, Math.abs(unten - oben));
    }
  }
  if (!seiten || breite <= 0 || hoehe <= 0) return null;
  return {
    pageWidthPt: breite,
    pageHeightPt: hoehe,
    pageCount: seiten,
    firstPrintedPage: ersteGedruckte,
  };
}

/**
 * Die Druckbogen in der Reihenfolge des Dokuments.
 *
 * Im Archiv stehen sie in beliebiger Ordnung; welche zuerst kommt, sagt
 * `designmap.xml`. Ohne diese Reihenfolge waere die erste gefundene Seite
 * irgendeine — und die gedruckte Zahl daraus wertlos.
 */
async function bogenInReihenfolge(zip: JSZip, parser: DOMParser): Promise<string[]> {
  const alle = Object.keys(zip.files).filter((n) => n.startsWith("Spreads/"));
  const karte = zip.files["designmap.xml"];
  if (!karte) return alle.sort();
  try {
    const xml = parser.parseFromString(await karte.async("text"), "text/xml");
    const reihe: string[] = [];
    for (const el of Array.from(xml.getElementsByTagName("idPkg:Spread"))) {
      const src = el.getAttribute("src");
      if (src && zip.files[src]) reihe.push(src);
    }
    for (const n of alle) if (!reihe.includes(n)) reihe.push(n);
    return reihe.length ? reihe : alle.sort();
  } catch {
    return alle.sort();
  }
}
