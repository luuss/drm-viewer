/**
 * Welcher Absatz liegt unter einem Tipp auf die Druckseite?
 *
 * Die Bloecke kennen nur ihre Druckseite und ihre senkrechte Lage, nicht die
 * Spalte. Die Textrahmen des Artikels (`articleRegions`) kennen die Spalten.
 * Daraus ergibt sich der Anteil des Leseflusses vor dem Tipp: erst die
 * Spalten links, dann der Weg in der getroffenen Spalte nach unten. Diesen
 * Anteil legen wir auf die Absaetze der Seite, gewichtet nach Textlaenge.
 * Genauer geht es, wenn sich die Spaltenwechsel aus der senkrechten Lage der
 * Absaetze ablesen lassen: dann zaehlt der Absatz der getroffenen Spalte, der
 * am naechsten ueber dem Tipp beginnt.
 */

export type Rahmen = { x0: number; y0: number; x1: number; y1: number };
export type Absatz = { order: number; text: string; sourceY?: number | null };

/** Rahmen in Lesereihenfolge: Spalten von links, darin von oben. */
function lesefolge(rahmen: Rahmen[]): Rahmen[] {
  const spalten: Rahmen[][] = [];
  for (const r of [...rahmen].sort((a, b) => a.x0 - b.x0)) {
    const spalte = spalten.find((s) =>
      s.some((o) => Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0.5 * (r.x1 - r.x0)),
    );
    if (spalte) spalte.push(r);
    else spalten.push([r]);
  }
  return spalten.flatMap((s) => s.sort((a, b) => a.y0 - b.y0));
}

function abstand(r: Rahmen, x: number, y: number) {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dy = Math.max(r.y0 - y, 0, y - r.y1);
  return dx * dx + dy * dy;
}

/** Der getroffene Rahmen (oder der naechste) in der Lesefolge. */
function getroffen(folge: Rahmen[], x: number, y: number): number {
  let treffer = 0;
  folge.forEach((r, i) => {
    if (abstand(r, x, y) < abstand(folge[treffer], x, y)) treffer = i;
  });
  return treffer;
}

/** Anteil des Leseflusses auf der Seite vor dem Punkt, 0..1. */
export function flussAnteil(rahmen: Rahmen[], x: number, y: number): number | null {
  const folge = lesefolge(rahmen);
  if (folge.length === 0) return null;
  const hoehen = folge.map((r) => Math.max(r.y1 - r.y0, 1e-6));
  const summe = hoehen.reduce((a, b) => a + b, 0);
  const treffer = getroffen(folge, x, y);
  const r = folge[treffer];
  const davor = hoehen.slice(0, treffer).reduce((a, b) => a + b, 0);
  const innen = Math.min(Math.max(y - r.y0, 0), hoehen[treffer]);
  return (davor + innen) / summe;
}

/** Letzter Absatz, der ueber dem Tipp beginnt; sonst der erste. */
function ueberDemTipp(absaetze: Absatz[], y: number): Absatz {
  let wahl = absaetze[0];
  for (const a of absaetze) if ((a.sourceY as number) <= y + 0.01) wahl = a;
  return wahl;
}

export function absatzBeiPunkt(
  absaetze: Absatz[],
  rahmen: Rahmen[],
  x: number,
  y: number,
): number | null {
  if (absaetze.length === 0) return null;
  const folge = [...absaetze].sort((a, b) => a.order - b.order);

  // Genau: Im Lesefluss springt die senkrechte Lage an jedem Spaltenwechsel
  // nach oben. Ergibt das so viele Laeufe wie Rahmen, gehoert Lauf k zu
  // Rahmen k, und im getroffenen Lauf entscheidet die Hoehe.
  if (folge.every((a) => a.sourceY != null)) {
    const laeufe: Absatz[][] = [];
    for (const a of folge) {
      const lauf = laeufe[laeufe.length - 1];
      if (lauf && (a.sourceY as number) >= (lauf[lauf.length - 1].sourceY as number)) {
        lauf.push(a);
      } else laeufe.push([a]);
    }
    const reihe = lesefolge(rahmen);
    if (laeufe.length === 1) return ueberDemTipp(laeufe[0], y).order;
    if (laeufe.length === reihe.length) {
      return ueberDemTipp(laeufe[getroffen(reihe, x, y)], y).order;
    }
  }

  // Sonst nach Textanteil: der Absatz, in dem der Anteil des Leseflusses liegt.
  const laengen = folge.map((a) => Math.max(a.text.length, 1));
  const gesamt = laengen.reduce((a, b) => a + b, 0);
  const anteil = flussAnteil(rahmen, x, y) ?? y;
  let lauf = 0;
  let schaetzung = folge[0];
  folge.forEach((a, i) => {
    if (lauf / gesamt <= anteil) schaetzung = a;
    lauf += laengen[i];
  });
  return schaetzung.order;
}
