import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { tableData } from "./schema";

/**
 * Eine Tabelle in einen bestehenden Artikel einsetzen, ohne Neuimport.
 *
 * Ein Neuimport verwirft die Freigaben der Redaktion (drm-viewer-6st). Fuer
 * Hefte, die vor der Tabellenunterstuetzung eingelesen wurden, setzt diese
 * Mutation den Tabellenblock gezielt ein. Die Daten dafuer kommen aus
 * derselben Auswertung wie beim Import (`extract-service`, siehe
 * `scripts/tabelle-einsetzen.py`).
 *
 * Frueher kamen die Zellen einer Tabelle als lose Absaetze heraus; stand die
 * Tabelle allein auf einer Seite, wurde daraus ein eigener "Artikel" mit dem
 * Zellentext als Titel. `ersetzt` nennt diesen Artikel: er geht im Zielartikel
 * auf. Seine Bilder und Klickflaechen wandern mit, seine Bloecke fallen weg —
 * aber nur, wenn jeder davon aus der Story der Tabelle stammt. Sonst bricht
 * die Mutation ab, statt echten Text zu loeschen.
 *
 * Wiederholbar: steht die Tabelle schon im Zielartikel, passiert nichts.
 */
export const einsetzenInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    articleId: v.id("articles"),
    // Hinter diesem Block (1-basiert); ohne Angabe ans Ende.
    afterBlockOrder: v.optional(v.number()),
    block: v.object({
      text: v.string(),
      table: tableData,
      sourcePageIndex: v.number(),
      sourceY: v.optional(v.number()),
      sourceStoryId: v.string(),
      sourceFrameId: v.optional(v.string()),
      styleName: v.optional(v.string()),
    }),
    ersetzt: v.optional(v.id("articles")),
    probelauf: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { issueId, articleId, block, ersetzt } = args;
    const ziel = await ctx.db.get(articleId);
    if (!ziel || ziel.issueId !== issueId) {
      throw new Error("Zielartikel gehoert nicht zu dieser Ausgabe");
    }
    const bloecke = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
      .collect();
    if (
      bloecke.some(
        (b) => b.type === "table" && b.sourceStoryId === block.sourceStoryId,
      )
    ) {
      return { schonDa: true as const };
    }
    const hinter = args.afterBlockOrder ?? Math.max(0, ...bloecke.map((b) => b.order));

    let alt: Doc<"articles"> | null = null;
    let altBloecke: Doc<"articleBlocks">[] = [];
    if (ersetzt) {
      alt = await ctx.db.get(ersetzt);
      if (!alt || alt.issueId !== issueId || alt._id === articleId) {
        throw new Error("Zu ersetzender Artikel passt nicht");
      }
      altBloecke = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", ersetzt))
        .collect();
      const fremd = altBloecke.filter(
        (b) => b.sourceStoryId !== block.sourceStoryId || b.type === "table",
      );
      if (fremd.length > 0) {
        throw new Error(
          `Artikel enthaelt ${fremd.length} Bloecke ausserhalb der Tabelle, Abbruch`,
        );
      }
    }

    const plan = {
      schonDa: false as const,
      ziel: ziel.title,
      hinterBlock: hinter,
      verschobeneBloecke: bloecke.filter((b) => b.order > hinter).length,
      ersetzt: alt ? { titel: alt.title, bloecke: altBloecke.length } : null,
    };
    if (args.probelauf) return { ...plan, probelauf: true };

    for (const b of bloecke) {
      if (b.order > hinter) await ctx.db.patch(b._id, { order: b.order + 1 });
    }
    // Bilder, die hinter einem verschobenen Block verankert sind, gehen mit.
    const bilder = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const bild of bilder) {
      if (bild.afterBlockOrder !== undefined && bild.afterBlockOrder > hinter) {
        await ctx.db.patch(bild._id, { afterBlockOrder: bild.afterBlockOrder + 1 });
      }
    }
    await ctx.db.insert("articleBlocks", {
      articleId,
      issueId,
      order: hinter + 1,
      type: "table",
      text: block.text,
      table: block.table,
      sourcePageIndex: block.sourcePageIndex,
      sourceY: block.sourceY,
      sourceStoryId: block.sourceStoryId,
      sourceFrameId: block.sourceFrameId,
      styleName: block.styleName,
    });

    let pageStart = Math.min(ziel.pageStart, block.sourcePageIndex);
    let pageEnd = Math.max(ziel.pageEnd, block.sourcePageIndex);
    if (alt) {
      await aufgehenLassen(ctx, alt, articleId, bilder.length, altBloecke);
      pageStart = Math.min(pageStart, alt.pageStart);
      pageEnd = Math.max(pageEnd, alt.pageEnd);
    }
    await ctx.db.patch(articleId, { pageStart, pageEnd });
    await suchtextNeu(ctx, articleId);
    if (alt) await neuNummerieren(ctx, issueId);

    await ctx.db.insert("auditLog", {
      action: "article.table.insert",
      target: articleId,
      detail: `Tabelle ${block.sourceStoryId}${alt ? `, ersetzt ${alt._id}` : ""}`,
      createdAt: Date.now(),
    });
    return plan;
  },
});

/** Bilder, Flaechen und Verweise des Zellen-Artikels uebernehmen, ihn loeschen. */
async function aufgehenLassen(
  ctx: MutationCtx,
  alt: Doc<"articles">,
  ziel: Id<"articles">,
  bilderImZiel: number,
  altBloecke: Doc<"articleBlocks">[],
) {
  const regionen = await ctx.db
    .query("articleRegions")
    .withIndex("by_article", (q) => q.eq("articleId", alt._id))
    .collect();
  for (const r of regionen) await ctx.db.patch(r._id, { articleId: ziel });

  const bilder = await ctx.db
    .query("articleAssets")
    .withIndex("by_article", (q) => q.eq("articleId", alt._id))
    .collect();
  for (const bild of bilder.sort((a, b) => a.order - b.order)) {
    // Ein Anker bezog sich auf die Bloecke des alten Artikels; die gibt es
    // nicht mehr. Ohne Anker ordnet der Leser nach Seite und Hoehe.
    await ctx.db.patch(bild._id, {
      articleId: ziel,
      order: bilderImZiel + bild.order,
      afterBlockOrder: undefined,
    });
  }

  // Das automatische Verzeichnis traegt den Zellentext als Eintrag; ein
  // neuer Import legt ihn nicht mehr an, also faellt er weg. Ein von Hand
  // gesetzter Eintrag zeigt kuenftig auf den Zielartikel.
  const toc = await ctx.db
    .query("tocEntries")
    .withIndex("by_issue_order", (q) => q.eq("issueId", alt.issueId))
    .collect();
  let geloescht = false;
  for (const t of toc) {
    if (t.articleId !== alt._id) continue;
    if (t.label === alt.title.slice(0, 300)) {
      await ctx.db.delete(t._id);
      geloescht = true;
    } else {
      await ctx.db.patch(t._id, { articleId: ziel });
    }
  }
  if (geloescht) {
    let i = 1;
    for (const t of toc) {
      const noch = await ctx.db.get(t._id);
      if (!noch) continue;
      if (noch.order !== i) await ctx.db.patch(t._id, { order: i });
      i++;
    }
  }
  // Lesestaende haben keinen Index auf den Artikel. Die Tabelle ist klein,
  // und dieser Weg laeuft einmal je Heft.
  for await (const stand of ctx.db.query("readingProgress")) {
    if (stand.articleId === alt._id) await ctx.db.patch(stand._id, { articleId: ziel });
  }

  for (const b of altBloecke) await ctx.db.delete(b._id);
  await ctx.db.delete(alt._id);
}

async function suchtextNeu(ctx: MutationCtx, articleId: Id<"articles">) {
  const article = await ctx.db.get(articleId);
  if (!article) return;
  const bloecke = await ctx.db
    .query("articleBlocks")
    .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
    .collect();
  const teile = [article.title, article.subtitle ?? "", article.teaser ?? ""];
  for (const b of bloecke) teile.push(b.text);
  await ctx.db.patch(articleId, {
    searchText: teile.filter(Boolean).join("\n\n").slice(0, 100000),
    updatedAt: Date.now(),
  });
}

/** Reihenfolge 1..n wie beim Zusammenfuehren in der Redaktion, Zaehler dazu. */
async function neuNummerieren(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
    .collect();
  let i = 1;
  for (const r of rows) {
    if (r.order !== i) await ctx.db.patch(r._id, { order: i });
    i++;
  }
  await ctx.db.patch(issueId, { articleCount: rows.length, updatedAt: Date.now() });
}
