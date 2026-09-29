/**
 * Tabellen aus dem Satz, wie sie `articles.getForReader` liefert.
 *
 * Jede Zeile nennt nur die Zellen, die in ihr beginnen; verbundene Zellen
 * tragen `rowSpan`/`colSpan`. Mehrere Absaetze einer Zelle trennt "\n".
 */
export type TabellenZelle = {
  text: string;
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
  emphasis?: boolean;
};

export type Tabelle = {
  headerRows: number;
  columnWidths?: number[];
  rows: TabellenZelle[][];
};

const ZAHL = /^[\d\s.,:%/–-]+$/;

/** Spaltenzahl: die breiteste Zeile, verbundene Zellen mitgezaehlt. */
export function spaltenZahl(t: Tabelle): number {
  if (t.columnWidths?.length) return t.columnWidths.length;
  return Math.max(
    0,
    ...t.rows.map((row) => row.reduce((n, c) => n + (c.colSpan ?? 1), 0)),
  );
}

/**
 * Spalten, in denen unter dem Kopf nur Zahlen stehen ("1", "38"). Sie werden
 * mittig gesetzt wie im Heft. Bei verbundenen Zellen ist die Spalte einer
 * Zelle nicht mehr ihr Index; dann bleibt alles linksbuendig.
 */
export function zahlenSpalten(t: Tabelle): Set<number> {
  const out = new Set<number>();
  if (t.rows.some((row) => row.some((c) => (c.rowSpan ?? 1) > 1 || (c.colSpan ?? 1) > 1))) {
    return out;
  }
  const koerper = t.rows.slice(t.headerRows);
  if (koerper.length === 0) return out;
  for (let i = 0; i < spaltenZahl(t); i++) {
    const werte = koerper.map((row) => row[i]?.text.trim() ?? "").filter(Boolean);
    if (werte.length > 0 && werte.every((w) => ZAHL.test(w))) out.add(i);
  }
  return out;
}

/** Kopfbeschriftung fuer Vorlesegeraete: die Zellen der ersten Kopfzeile. */
export function tabellenName(t: Tabelle): string {
  const kopf = t.rows[0]?.filter((c) => c.header).map((c) => c.text.trim()) ?? [];
  return kopf.length ? `Tabelle: ${kopf.join(", ")}` : "Tabelle";
}

/** Zellen bis zu dieser Laenge umbrechen nicht. */
export const KURZE_ZELLE = 28;

export function istKurz(text: string): boolean {
  return text.length <= KURZE_ZELLE && !text.includes("\n");
}
