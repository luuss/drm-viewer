import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * Volltextsuche ueber alle veroeffentlichten Hefte.
 *
 * Der Suchtext eines Artikels ist bis 100 000 Zeichen lang. Wuerde die Suche
 * direkt auf `articles` laufen, laese jeder Tastendruck dutzende solcher
 * Dokumente. Deshalb liegt der Text hier in kurzen Stuecken mit Titel und
 * Seite daneben: ein Treffer kostet gut ein Kilobyte, und die Artikel selbst
 * werden beim Suchen gar nicht gelesen.
 *
 * Die Stuecke gibt es nur fuer freigegebene Artikel veroeffentlichter Hefte.
 * Ihr Text verlaesst den Server nur fuer Hefte, auf die der Leser Zugriff hat;
 * bei allen anderen nennt die Suche nur Titel und Seite.
 */

/** Laenge eines Stuecks und Ueberlappung, damit kein Wort an der Grenze verloren geht. */
const STUECK = 1200;
const UEBERLAPPUNG = 120;

function stuecke(text: string): string[] {
  const out: string[] = [];
  const t = text.replace(/\s+/g, " ").trim();
  let start = 0;
  while (start < t.length) {
    let ende = Math.min(t.length, start + STUECK);
    // Am Wortende schneiden, nicht mitten im Wort.
    if (ende < t.length) {
      const leer = t.lastIndexOf(" ", ende);
      if (leer > start + STUECK / 2) ende = leer;
    }
    out.push(t.slice(start, ende));
    if (ende >= t.length) break;
    // Das naechste Stueck beginnt etwas vor dem Ende, an einem Wortanfang.
    const zurueck = t.indexOf(" ", ende - UEBERLAPPUNG);
    start = zurueck > start && zurueck < ende ? zurueck + 1 : ende;
  }
  return out;
}

/**
 * Die Woerter fuer den Suchindex. Convex verknuepft sie mit ODER und nimmt das
 * letzte als Wortanfang. Ein einzelner Buchstabe passt damit auf fast jeden
 * Text ("homo-e" fand 33 Hefte); solche Reste bleiben draussen und werden erst
 * von `passt` geprueft.
 */
export function suchwoerter(begriff: string): string | null {
  const woerter = begriff
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  return woerter.length ? woerter.join(" ") : null;
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Jeder Teil der Eingabe muss im Text an einem Wortanfang stehen, so wie er
 * getippt ist. "homo-e" passt auf "Homo-Ehen", "plan b" auf "Plan B für".
 */
export function passt(text: string, begriff: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  return begriff
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((teil) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(teil)}`, "u").test(t));
}

/** Fundstelle in einem Stueck: der Ausschnitt um den ersten passenden Teil. */
export function ausschnitt(text: string, begriff: string): string {
  const t = text.replace(/\s+/g, " ");
  const teil = begriff.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? "";
  const idx = Math.max(0, t.toLowerCase().indexOf(teil));
  const start = Math.max(0, idx - 70);
  return (start > 0 ? "..." : "") + t.slice(start, start + 220) + "...";
}

/** Stuecke eines Artikels neu anlegen, oder entfernen, wenn er nicht (mehr) gesucht wird. */
export const artikelNeu = internalMutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const alt = await ctx.db
      .query("searchChunks")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const s of alt) await ctx.db.delete(s._id);

    const article = await ctx.db.get(articleId);
    if (!article || article.reviewStatus !== "approved") return;
    const issue = await ctx.db.get(article.issueId);
    if (!issue?.isPublished) return;
    for (const text of stuecke(article.searchText)) {
      await ctx.db.insert("searchChunks", {
        articleId,
        issueId: article.issueId,
        title: article.title,
        subtitle: article.subtitle,
        pageIndex: article.primaryPageIndex,
        text,
      });
    }
  },
});

/**
 * Alle Stuecke eines Hefts neu: beim Veroeffentlichen, Zurueckziehen und
 * Loeschen. Jeder Artikel laeuft als eigene Mutation, damit ein dickes Heft
 * nicht an die Grenzen einer einzelnen stoesst.
 */
export const heftNeu = internalMutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await heftStueckeLoeschen(ctx, issueId);
    const issue = await ctx.db.get(issueId);
    if (!issue?.isPublished) return;
    const artikel = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const a of artikel) {
      if (a.reviewStatus !== "approved") continue;
      await ctx.scheduler.runAfter(0, internal.suche.artikelNeu, { articleId: a._id });
    }
  },
});

/** Einmalig und nach Bedarf: die Stuecke aller Hefte neu aufbauen. */
export const allesNeu = internalMutation({
  args: {},
  handler: async (ctx) => {
    for await (const issue of ctx.db.query("issues")) {
      await ctx.scheduler.runAfter(0, internal.suche.heftNeu, { issueId: issue._id });
    }
  },
});

export async function heftStueckeLoeschen(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("searchChunks")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}

/**
 * Nach jeder Aenderung an einem Artikel aufrufen. Nur bei veroeffentlichten
 * Heften gibt es Stuecke; sonst kostet der Aufruf nur das Lesen des Hefts.
 */
export async function sucheVormerken(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  articleId: Id<"articles">,
) {
  const issue = await ctx.db.get(issueId);
  if (!issue?.isPublished) return;
  await ctx.scheduler.runAfter(0, internal.suche.artikelNeu, { articleId });
}
