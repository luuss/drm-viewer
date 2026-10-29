import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";

/**
 * Wohin eine Klickflaeche des Inhaltsverzeichnisses (oder ein Anreisser der
 * Titelseite) fuehrt und an welchem Artikel sie haengt.
 *
 * Die Flaeche springt zur Seite `targetPageIndex`; der Artikel entscheidet
 * nur, ob sie im Reader erscheint (freigegeben oder nicht). Haengt sie an
 * einem Artikel, der spaeter wegfaellt (Nachtrag, Loeschen), darf sie nicht
 * mit ihm verschwinden: sie liegt auf einer anderen Seite als der Artikel.
 * So gingen in DMZ 170 die Zeilen "Nachrichten aus Deutschland" und
 * "Nachrichten aus aller Welt" verloren, als ein Nachtrag die Meldungen zu
 * einem Artikel zusammenfasste (drm-viewer-ag3).
 */

/** Vergleichsform eines Titels: klein, nur Buchstaben und Ziffern, ohne doppelte Woerter. */
export function titelForm(text: string): string {
  const woerter = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  // Ein Druckfehler wie "Nachrichten aus aus aller Welt" zaehlt nicht.
  return woerter.filter((w, i) => w !== woerter[i - 1]).join(" ");
}

type ArtikelKurz = Pick<Doc<"articles">, "_id" | "order" | "title" | "pageStart" | "pageEnd">;
type EintragKurz = Pick<Doc<"tocEntries">, "label" | "pageIndex" | "articleId">;

/**
 * Die Zielseite einer Verzeichniszeile. Die gedruckte Seitenzahl gilt, ausser
 * die Redaktion hat den Eintrag mit genau diesem Titel auf eine andere Seite
 * gelegt (Druckfehler im Verzeichnis: DMZ 170 nennt fuer "Nachrichten aus
 * aller Welt" die 35, die Meldungen stehen auf 51), oder genau ein Artikel
 * traegt den Titel und beginnt woanders, waehrend auf der gedruckten Seite
 * keiner mit dem Titel steht.
 */
export function zielSeite(
  label: string | undefined,
  gedruckt: number,
  toc: EintragKurz[],
  articles: ArtikelKurz[],
): number {
  if (!label) return gedruckt;
  const form = titelForm(label);
  if (!form) return gedruckt;
  const eintraege = toc.filter((t) => t.pageIndex !== undefined && titelForm(t.label) === form);
  if (eintraege.length === 1) return eintraege[0].pageIndex!;
  if (eintraege.length > 1) return gedruckt;
  const gleich = articles.filter((a) => titelForm(a.title) === form);
  if (gleich.length !== 1) return gedruckt;
  // Beginnt der Artikel auf der Folgeseite, ist die gedruckte Seite seine
  // Aufmacherseite mit Bild, kein Druckfehler.
  if (gleich[0].pageStart === gedruckt + 1) return gedruckt;
  const aufSeite = articles.some(
    (a) => a.pageStart <= gedruckt && gedruckt <= a.pageEnd && titelForm(a.title) === form,
  );
  return aufSeite ? gedruckt : gleich[0].pageStart;
}

/**
 * Der Artikel, an dem eine Flaeche mit Ziel `pageIndex` haengt: der des
 * Verzeichniseintrags, sonst der auf der Seite beginnende, sonst (Aufmacher-
 * seite mit Bild) der auf der Folgeseite beginnende, wenn kein eigener
 * Eintrag auf sie zeigt, sonst der, der ueber die Seite laeuft ("Leser-
 * briefe/Impressum 81": die Briefe beginnen auf 80). Laufen mehrere ueber
 * die Seite, gewinnt der, dessen Titel im Eintrag steht, dann der erste.
 */
export function zielArtikelWaehlen(args: {
  articles: ArtikelKurz[];
  toc: EintragKurz[];
  ziele: Set<number>;
  pageIndex: number;
  label?: string;
  ausser?: Set<string>;
}): Id<"articles"> | undefined {
  const { toc, ziele, pageIndex, label } = args;
  const ausser = args.ausser ?? new Set<string>();
  const articles = [...args.articles]
    .filter((a) => !ausser.has(a._id as string))
    .sort((a, b) => a.order - b.order);
  const vorhanden = new Set(articles.map((a) => a._id as string));
  const ab = (seite: number): Id<"articles"> | undefined => {
    const eintrag = toc.find(
      (t) =>
        t.pageIndex === seite && t.articleId !== undefined && vorhanden.has(t.articleId as string),
    );
    if (eintrag?.articleId) return eintrag.articleId;
    return articles.find((a) => a.pageStart === seite)?._id;
  };
  const genau = ab(pageIndex);
  if (genau) return genau;
  if (!ziele.has(pageIndex + 1)) {
    const folge = ab(pageIndex + 1);
    if (folge) return folge;
  }
  const darueber = articles.filter((a) => a.pageStart <= pageIndex && pageIndex <= a.pageEnd);
  if (!darueber.length) return undefined;
  const form = label ? titelForm(label) : "";
  const passend = darueber.find((a) => {
    const t = titelForm(a.title);
    return t.length >= 4 && form.includes(t);
  });
  return (passend ?? darueber[0])._id;
}

/**
 * Die Sprungflaechen eines wegfallenden Artikels an einen bleibenden haengen,
 * gewaehlt wie beim Anlegen (`zielArtikelWaehlen`). Findet sich keiner,
 * faellt die Flaeche weg. Gibt die Zahl der umgehaengten Flaechen zurueck.
 * Aufrufen, wenn der wegfallende Artikel schon geloescht ist oder in
 * `ausser` steht, und neue Artikel schon eingefuegt sind.
 */
export async function sprungflaechenRetten(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  regionen: Doc<"articleRegions">[],
  ausser: Set<string>,
): Promise<number> {
  const nav = regionen.filter((r) => r.targetPageIndex !== undefined);
  if (!nav.length) return 0;
  const articles = await ctx.db
    .query("articles")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const toc = await ctx.db
    .query("tocEntries")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const alle = await ctx.db
    .query("articleRegions")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const ziele = new Set(
    alle.filter((r) => r.targetPageIndex !== undefined).map((r) => r.targetPageIndex!),
  );
  let gerettet = 0;
  for (const r of nav) {
    const articleId = zielArtikelWaehlen({
      articles,
      toc,
      ziele,
      pageIndex: r.targetPageIndex!,
      ausser,
    });
    if (articleId) {
      await ctx.db.patch(r._id, { articleId });
      gerettet++;
    } else {
      await ctx.db.delete(r._id);
    }
  }
  return gerettet;
}
