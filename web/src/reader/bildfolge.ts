// Hinter einem Zwischentitel steht kein Bild: es truege ihn von seinem Text weg.
const KOEPFE = new Set(["heading", "subheading"]);

type Platziert = { page: number; y: number };

/**
 * Lesefolge fuer Bilder ohne Absatzanker, ueber eine Folge von Seiten.
 *
 * Frueher kam jedes Bild unterhalb des ersten Absatzes hinter den ganzen
 * Text seiner Seite; im Leser standen dann viele Absaetze und danach alle
 * Bilder. Jetzt bleibt jedes Bild in seiner Reihenfolge und bei seiner
 * Seite, verteilt sich aber gleichmaessig zwischen deren Absaetze. Ein Bild
 * ueber dem Text seiner Seite steht vor ihm. Zwischen zwei Bildern steht
 * mindestens ein Absatz; nur wenn es mehr Bilder als Absaetze gibt, ruecken
 * welche zusammen.
 *
 * `blocks` in Lesefolge, Seite fuer Seite; `images` in Druckfolge.
 */
export function bildfolge<B extends Platziert & { block: { type: string } }, I extends Platziert>(
  blocks: B[],
  images: I[],
): (B | I)[] {
  if (!images.length) return blocks;
  const reihe = [...images].sort((a, b) => a.page - b.page || a.y - b.y);

  // Wunschstelle je Bild, gezaehlt in Bloecken davor.
  const wunsch: number[] = [];
  for (const seite of new Set(reihe.map((bild) => bild.page))) {
    const davor = blocks.filter((b) => b.page < seite).length;
    const eigene = blocks.filter((b) => b.page === seite);
    const erste = Math.min(...eigene.map((b) => b.y), 1);
    const bilder = reihe.filter((bild) => bild.page === seite);
    const unten = bilder.filter((bild) => bild.y >= erste).length;
    let k = 0;
    for (const bild of bilder) {
      wunsch.push(
        bild.y < erste ? davor : davor + (++k * eigene.length) / (unten + 1),
      );
    }
  }

  // Erlaubt: vor dem ersten Block und hinter jedem, der kein Titel ist. Zwei
  // verschiedene Stellen trennt so immer mindestens ein Absatz.
  const stellen = [
    0,
    ...blocks.flatMap((b, i) => (KOEPFE.has(b.block.type) ? [] : [i + 1])),
  ];
  const n = stellen.length;
  const m = reihe.length;
  const platz = wunsch.map((t) => {
    let beste = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(stellen[i] - t) <= Math.abs(stellen[beste] - t)) beste = i;
    }
    return beste;
  });
  if (m <= n) {
    for (let i = 1; i < m; i++) platz[i] = Math.max(platz[i], platz[i - 1] + 1);
    for (let i = m - 1; i >= 0; i--) {
      platz[i] = Math.min(platz[i], n - m + i, i < m - 1 ? platz[i + 1] - 1 : n);
    }
  } else {
    for (let i = 0; i < m; i++) platz[i] = Math.floor((i * n) / m);
  }

  const nach = new Map<number, I[]>();
  reihe.forEach((bild, i) => {
    const stelle = stellen[platz[i]];
    nach.set(stelle, [...(nach.get(stelle) ?? []), bild]);
  });
  return [...(nach.get(0) ?? []), ...blocks.flatMap((b, i) => [b, ...(nach.get(i + 1) ?? [])])];
}
