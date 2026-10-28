/**
 * Der Artikel, der eine Leserseite abdeckt; bei mehreren der erste im Heft.
 *
 * Ein Eintrag im Inhaltsverzeichnis ohne eigenen Artikel ("Leserbriefe/
 * Impressum") kennt nur seine Seite. Im Artikelmodus schaltete er frueher
 * ungefragt in den Seitenmodus; jetzt oeffnet er den Artikel dieser Seite.
 */
export function artikelAufSeite<A extends { pageStart: number; pageEnd: number }>(
  artikel: A[],
  seite: number,
): A | null {
  return artikel.find((a) => a.pageStart <= seite && seite <= a.pageEnd) ?? null;
}
