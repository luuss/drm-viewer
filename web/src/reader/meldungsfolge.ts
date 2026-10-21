// Ein Bild steht auf einer Meldungsseite in der Zeile seiner Meldung: sein
// oberer Rand liegt hoechstens so weit ueber deren Zeile.
const MELDUNG_TOLERANZ = 0.04;
// Zwei Zeilen, die naeher beieinander stehen, sind zwei Spalten derselben
// Hoehe; ohne waagerechte Lage ist dann nicht zu sagen, welche gemeint ist.
const MELDUNG_EINDEUTIG = 0.02;

type Platziert = { y: number };

/**
 * Lesefolge einer Meldungsseite fuer Bilder ohne Absatzanker.
 *
 * Eine Rubrikseite ("Nachrichten aus aller Welt") ist ein Artikel, die
 * Zeilen der Meldungen sind Zwischentitel, und jedes Bild steht in der Hoehe
 * seiner Zeile. Ohne Anker landeten alle Bilder unter der ersten Zeile hinter
 * der letzten Meldung. Hier kommt jedes Bild hinter die Zeile, in deren Hoehe
 * es steht. Neuere Importe setzen den Anker selbst; das hier traegt den
 * Bestand. Kein Ergebnis (null), wenn die Seite keine Meldungsseite ist oder
 * ein Bild nicht eindeutig zuzuordnen ist.
 */
export function meldungsfolge<
  B extends Platziert & { order: number; block: { type: string } },
  I extends Platziert,
>(blocks: B[], images: I[]): (B | I)[] | null {
  const zeilen = blocks.filter((item) => item.block.type === "subheading");
  if (zeilen.length < 2 || blocks[0]?.block.type !== "subheading" || !images.length) {
    return null;
  }
  const nach = new Map<number, I[]>();
  const davor: I[] = [];
  for (const image of images) {
    const kandidaten = zeilen.filter((z) => z.y <= image.y + MELDUNG_TOLERANZ);
    if (!kandidaten.length) {
      davor.push(image);
      continue;
    }
    const hoechste = Math.max(...kandidaten.map((z) => z.y));
    const treffer = kandidaten.filter((z) => hoechste - z.y < MELDUNG_EINDEUTIG);
    if (treffer.length !== 1) return null;
    nach.set(treffer[0].order, [...(nach.get(treffer[0].order) ?? []), image]);
  }
  return [...davor, ...blocks.flatMap((block) => [block, ...(nach.get(block.order) ?? [])])];
}
