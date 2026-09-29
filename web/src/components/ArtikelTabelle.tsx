import type { CSSProperties } from "react";
import {
  spaltenZahl,
  tabellenName,
  zahlenSpalten,
  type Tabelle,
  type TabellenZelle,
} from "../lib/tabelle";

/**
 * Eine Tabelle aus dem Heft als echte HTML-Tabelle.
 *
 * Kopfzellen sind `th`, der Rest `td`. Auf dem Telefon ist die Tabelle meist
 * breiter als der Schirm; dann rollt sie seitlich in ihrem Rahmen, statt die
 * Spalten bis zur Unlesbarkeit zu quetschen. Der Rahmen ist per Tastatur
 * erreichbar, damit sich auch ohne Maus seitlich rollen laesst.
 *
 * Die Spaltenbreiten aus dem Satz (`columnWidths`) gelten fuer die Schrift
 * des Drucks. Am Schirm verteilt der Browser die Breite besser selbst; fest
 * vorgegeben trennten die Kopfzellen mitten im Wort ("Schwer-ter-Nr.").
 */
export default function ArtikelTabelle({
  table,
  sourcePage,
}: {
  table: Tabelle;
  sourcePage?: number;
}) {
  const kopf = table.rows.slice(0, table.headerRows);
  const koerper = table.rows.slice(table.headerRows);
  const zahlen = zahlenSpalten(table);
  const stil = { "--spalten": spaltenZahl(table) } as CSSProperties;

  const zelle = (c: TabellenZelle, i: number, imKopf: boolean) => {
    const spannen = {
      ...((c.colSpan ?? 1) > 1 ? { colSpan: c.colSpan } : {}),
      ...((c.rowSpan ?? 1) > 1 ? { rowSpan: c.rowSpan } : {}),
    };
    const klassen = [zahlen.has(i) ? "zahl" : "", c.emphasis ? "hervor" : ""]
      .filter(Boolean)
      .join(" ");
    if (imKopf || c.header) {
      const scope = imKopf ? ((c.colSpan ?? 1) > 1 ? "colgroup" : "col") : "row";
      return (
        <th key={i} scope={scope} className={klassen || undefined} {...spannen}>
          {c.text}
        </th>
      );
    }
    return (
      <td key={i} className={klassen || undefined} {...spannen}>
        {c.text}
      </td>
    );
  };

  return (
    <div
      className="article-table"
      role="region"
      aria-label={tabellenName(table)}
      tabIndex={0}
      data-source-page={sourcePage}
    >
      <table style={stil}>
        {kopf.length > 0 && (
          <thead>
            {kopf.map((row, r) => (
              <tr key={r}>{row.map((c, i) => zelle(c, i, true))}</tr>
            ))}
          </thead>
        )}
        <tbody>
          {koerper.map((row, r) => (
            <tr key={r}>{row.map((c, i) => zelle(c, i, false))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
