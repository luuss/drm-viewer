/**
 * Wohin ein Tipp auf die Druckseite fuehrt. Reine Funktion, damit sich die
 * Regeln ohne Betrachter testen lassen (tippZiel.test.ts).
 *
 * Auf einer Buchanzeige liegen zwei Dinge uebereinander: das Buch im Laden
 * und der Anzeigentext als Artikel. Die Regel ist fest, eine Rueckfrage gibt
 * es nur, wenn das Ziel wirklich offen ist:
 *
 * * **Umschlagbild** (Bildflaeche eines Artikels oder Buchflaeche ohne Text
 *   darunter): das Produkt im Laden, neuer Tab. Nennt die Anzeige mehrere
 *   Buecher und liegt die Buchflaeche ueber mehreren Umschlaegen, fragt die
 *   Auswahl, welches Buch gemeint ist.
 * * **Text**: der Artikel, beim angetippten Absatz. Der Knopf "Buch im Shop
 *   kaufen" steht dort unter der Anzeige.
 * * Andere Flaechen nach draussen (Abo-Aufruf, Sammelanzeige, Umschlag)
 *   gehen immer vor; ein Verzeichniseintrag springt auf seine Seite.
 */

export type TippRegion = {
  articleId: string;
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** "image": Bild des Artikels; nur fuer den Treffertest, keine eigene Klickflaeche. */
  kind?: string;
  targetPageIndex: number | null;
};

export type TippLink = {
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  url: string;
  label: string | null;
};

export type TippAnzeige = {
  isAd: boolean;
  products: { productId: number | null; url: string }[];
};

export type TippZiel<A extends string = string> =
  | { art: "laden"; url: string }
  | { art: "artikel"; articleId: A }
  | { art: "auswahl"; articleId: A }
  | { art: "seite"; pageIndex: number };

/** Trenner im Label einer Buchflaeche ("Titel · Verfasser"), wie convex/pageLinks.ts. */
const BUCH_TRENNER = " · ";

type Box = { x0: number; y0: number; x1: number; y1: number };
const flaeche = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);
const enthaelt = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
const liegtIn = (innen: Box, aussen: Box, rand = 0.01) =>
  innen.x0 >= aussen.x0 - rand &&
  innen.y0 >= aussen.y0 - rand &&
  innen.x1 <= aussen.x1 + rand &&
  innen.y1 <= aussen.y1 + rand;
const kleinste = <T extends Box>(boxen: T[]): T | null =>
  boxen.reduce<T | null>((best, b) => (!best || flaeche(b) < flaeche(best) ? b : best), null);

/** Eine Produktseite des Ladens, keine Suchseite. */
export const istProduktseite = (url: string) => !/\/suche\?/.test(url);

export function tippZiel<A extends string>(
  punkt: { pageIndex: number; x: number; y: number },
  links: TippLink[],
  regions: (TippRegion & { articleId: A })[],
  anzeigen: ReadonlyMap<A, TippAnzeige>,
): TippZiel<A> | null {
  const { pageIndex, x, y } = punkt;
  const aufSeite = regions.filter((r) => r.pageIndex === pageIndex);
  const getroffen = aufSeite.filter((r) => enthaelt(r, x, y));
  const link = kleinste(links.filter((l) => l.pageIndex === pageIndex && enthaelt(l, x, y)));
  const buchLink = link?.label?.includes(BUCH_TRENNER) ? link : null;

  // Abo-Aufruf, Sammelanzeige, Umschlag: immer nach draussen.
  if (link && !buchLink) return { art: "laden", url: link.url };

  const bild = kleinste(getroffen.filter((r) => r.kind === "image"));
  const text = kleinste(getroffen.filter((r) => r.kind !== "image"));

  const anzeigeVon = (articleId: A) => {
    const a = anzeigen.get(articleId);
    return a?.isAd && a.products.length > 0 ? a : null;
  };

  // Text: der Artikel. Liegt eine Buchflaeche ganz im Text (Umschlag in
  // einer Besprechungsspalte), ist die kleinere Flaeche das Ziel.
  if (text && !bild && (!buchLink || flaeche(text) <= flaeche(buchLink) + 1e-9)) {
    if (text.targetPageIndex !== null) return { art: "seite", pageIndex: text.targetPageIndex };
    return { art: "artikel", articleId: text.articleId };
  }

  // Umschlag. Zu welcher Anzeige gehoert er: zum eigenen Artikel, wenn der
  // eine Anzeige ist, sonst zur Anzeige, in deren Text er steht.
  const anzeigeId =
    (bild && anzeigeVon(bild.articleId) ? bild.articleId : null) ??
    getroffen
      .filter((r) => r.kind !== "image" && anzeigeVon(r.articleId))
      .sort((a, b) => flaeche(a) - flaeche(b))[0]?.articleId ??
    null;
  const anzeige = anzeigeId ? anzeigeVon(anzeigeId) : null;
  const produkte = anzeige?.products.filter((p) => p.productId !== null) ?? [];

  if (buchLink) {
    // Eine Buchflaeche ueber mehreren Umschlaegen nennt nur das erste Buch.
    const umschlaege = aufSeite.filter((r) => r.kind === "image" && liegtIn(r, buchLink)).length;
    const mehrdeutig = umschlaege >= 2 && produkte.length >= 2;
    if (!mehrdeutig && istProduktseite(buchLink.url)) return { art: "laden", url: buchLink.url };
  }
  if (anzeigeId && produkte.length === 1) return { art: "laden", url: produkte[0].url };
  if (anzeigeId && produkte.length > 1) return { art: "auswahl", articleId: anzeigeId };
  if (buchLink) return { art: "laden", url: buchLink.url };
  if (bild) return { art: "artikel", articleId: bild.articleId };
  if (text) {
    if (text.targetPageIndex !== null) return { art: "seite", pageIndex: text.targetPageIndex };
    return { art: "artikel", articleId: text.articleId };
  }
  return null;
}
