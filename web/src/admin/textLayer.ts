/**
 * Die Textebene der Druckseiten, wie pdf.js sie liest.
 *
 * Der Satz (IDML) kennt jeden Absatz, aber nicht, wo seine Zeilen auf der
 * Seite stehen — das entscheidet erst InDesign beim Umbruch. Das Druck-PDF
 * weiss es: jedes Stueck Text traegt sein Rechteck. Weil die Druckdatei den
 * Rechner nicht verlaesst, liest der Browser diese Rechtecke beim Import aus
 * und laedt nur sie hoch, als kleine JSON-Datei. Der Worker legt damit die
 * Klickflaechen des gedruckten Inhaltsverzeichnisses genau auf die Eintraege
 * (extract-service/extractor/toc_layout.py).
 *
 * Koordinaten sind Anteile der Seite im Netzformat (0..1, y von oben) —
 * dasselbe System wie die gerenderten Seiten und die Satzrahmen.
 */

/** [Text, x0, y0, x1, y1, Schriftgroesse in Punkt] */
export type TextItem = [string, number, number, number, number, number];

export type TextPage = { sourcePageIndex: number; items: TextItem[] };

/** Was vom Druckbogen abzuschneiden ist, in Punkt (siehe `anschnitt`). */
export type Schnitt = { links: number; oben: number; breite: number; hoehe: number };

/** Ein Textstueck, wie `page.getTextContent()` es liefert. */
type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
};

type Viewport = { convertToViewportPoint(x: number, y: number): number[] };

function anteil(wert: number): number {
  return Math.round(Math.min(1, Math.max(0, wert)) * 1e4) / 1e4;
}

/**
 * Die Textstuecke einer Seite auf das Netzformat normieren.
 *
 * `viewport` ist die ungedrehte Ansicht in Punkt (Massstab 1); sie rechnet
 * den PDF-Ursprung unten links auf oben links um. Der Ankerpunkt eines
 * Stuecks ist seine Grundlinie links; Breite und Hoehe kommen in Punkt mit.
 * Gedrehter Satz (Bildnachweise am Rand) und Stuecke ausserhalb des
 * Netzformats (Schnittmarken, Bogensignatur) fallen weg.
 */
export function normiereTextelemente(
  items: PdfTextItem[],
  viewport: Viewport,
  schnitt: Schnitt,
): TextItem[] {
  const out: TextItem[] = [];
  if (schnitt.breite <= 0 || schnitt.hoehe <= 0) return out;
  for (const it of items) {
    if (!it.str || !it.str.trim() || !it.transform || it.transform.length < 6) continue;
    const [, b, c, , e, f] = it.transform;
    if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3) continue;
    const breite = it.width ?? 0;
    const hoehe = it.height ?? 0;
    if (breite <= 0 || hoehe <= 0) continue;
    const [vx, vy] = viewport.convertToViewportPoint(e, f);
    const x0 = (vx - schnitt.links) / schnitt.breite;
    const x1 = (vx + breite - schnitt.links) / schnitt.breite;
    const y1 = (vy - schnitt.oben) / schnitt.hoehe;
    const y0 = (vy - hoehe - schnitt.oben) / schnitt.hoehe;
    if (x1 <= 0 || x0 >= 1 || y1 <= 0 || y0 >= 1) continue;
    out.push([it.str, anteil(x0), anteil(y0), anteil(x1), anteil(y1), Math.round(hoehe * 10) / 10]);
  }
  return out;
}

/** Die Textebene als Datei fuer den Upload. */
export function textebeneAlsBlob(pages: TextPage[]): Blob {
  return new Blob([JSON.stringify({ version: 1, pages })], { type: "application/json" });
}

/**
 * Das Netzformat aus dem Druck-PDF lesen, ohne Bibliothek.
 *
 * Fehlt die Satzdatei, steht das Netzformat nur in der TrimBox der Seiten.
 * pdf.js gibt sie nicht heraus; in Druckdaten aus InDesign steht sie aber
 * unkomprimiert in der Datei. Gesucht wird stueckweise, damit ein Heft von
 * hundertvierzig Megabyte nicht am Stueck im Speicher liegt. Findet sich
 * nichts, bleibt das Ergebnis offen und der Anschnitt stehen.
 */
export async function trimBoxAusPdf(
  file: Blob,
): Promise<{ breitePt: number; hoehePt: number } | undefined> {
  const muster = /\/TrimBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/;
  const chunkBytes = 8 * 1024 * 1024;
  const decoder = new TextDecoder("latin1");
  let tail = "";
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const bytes = await file.slice(offset, offset + chunkBytes).arrayBuffer();
      const text = tail + decoder.decode(bytes);
      const treffer = muster.exec(text);
      if (treffer) {
        const [x0, y0, x1, y1] = treffer.slice(1, 5).map(Number);
        const breitePt = Math.abs(x1 - x0);
        const hoehePt = Math.abs(y1 - y0);
        if (breitePt > 0 && hoehePt > 0) return { breitePt, hoehePt };
      }
      tail = text.slice(-96);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
