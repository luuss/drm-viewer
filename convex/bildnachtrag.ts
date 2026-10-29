import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { regionBox } from "./schema";

/**
 * Bilder-Nachtrag: je Artikel nur Bilder und Bildunterschriften neu, ohne
 * Neuimport (HANDOVER 4m, drm-viewer-jmm).
 *
 * Ein Neuimport verwirft die Freigaben der Redaktion, der Auftrag "nachtrag"
 * laesst unveraenderte Artikel samt Bildern stehen. Mit payload "bilder"
 * (Probelauf: "bilder-probe") baut der Worker die Bilder der Artikel neu, deren
 * Stories im Bestand genau ein Artikel traegt, und reicht sie hier ein. Text,
 * Titel, Freigabe, Lesestand und Verzeichnis bleiben unberuehrt.
 *
 * Rueckweg: `bestandInternal` vorher sichern, `wiederherstellenInternal` setzt
 * genau diese Zeilen zurueck. Die alten Bilddateien bleiben im Medienspeicher;
 * der Nachtrag legt seine unter eigenem Namen ab.
 */

const bildEingabe = v.object({
  assetId: v.id("assets"),
  caption: v.optional(v.string()),
  sourcePageIndex: v.optional(v.number()),
  sourceY: v.optional(v.number()),
  afterBlockOrder: v.optional(v.number()),
  // Anfang des Absatzes, hinter dem das Bild steht. Die Redaktion kann
  // Absaetze geaendert, geteilt oder geloescht haben; die Nummer allein
  // traefe dann den falschen.
  anchorText: v.optional(v.string()),
});

const flaecheEingabe = v.object({ pageIndex: v.number(), ...regionBox });

function normal(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Die Stelle im heutigen Text, hinter der das Bild steht — oder keine. */
export function ankerFinden(
  bloecke: { order: number; text: string }[],
  anker: string | undefined,
  nummer: number | undefined,
): number | undefined {
  if (anker) {
    const kopf = normal(anker).slice(0, 60);
    if (kopf.length >= 12) {
      const treffer = bloecke.filter((b) => normal(b.text).startsWith(kopf));
      if (treffer.length === 1) return treffer[0].order;
      if (treffer.length > 1 && nummer !== undefined) {
        // Gleicher Absatzanfang mehrfach: der mit der passenden Nummer.
        return (treffer.find((b) => b.order === nummer) ?? treffer[0]).order;
      }
    }
    // Absatz nicht mehr da: dann die Lage auf der Seite (sourceY).
    return undefined;
  }
  return nummer !== undefined && bloecke.some((b) => b.order === nummer) ? nummer : undefined;
}

async function bilderUndFlaechen(ctx: MutationCtx, articleId: Id<"articles">) {
  const bilder = await ctx.db
    .query("articleAssets")
    .withIndex("by_article", (q) => q.eq("articleId", articleId))
    .collect();
  const flaechen = (
    await ctx.db
      .query("articleRegions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect()
  ).filter((r) => r.kind === "image");
  return { bilder, flaechen };
}

export const ersetzenInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    workerId: v.string(),
    issueId: v.id("issues"),
    probe: v.boolean(),
    articles: v.array(
      v.object({
        articleId: v.id("articles"),
        images: v.array(bildEingabe),
        imageRegions: v.array(flaecheEingabe),
      }),
    ),
  },
  returns: v.object({
    artikel: v.number(),
    geaendert: v.number(),
    bilderVorher: v.number(),
    bilderNachher: v.number(),
    unterschriftenVorher: v.number(),
    unterschriftenNachher: v.number(),
    ohneAnker: v.number(),
  }),
  handler: async (ctx, { jobId, workerId, issueId, probe, articles }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.issueId !== issueId) throw new Error("Auftrag passt nicht zur Ausgabe");
    if (job.workerId && job.workerId !== workerId) {
      throw new Error("Sperre liegt bei einem anderen Worker");
    }
    const summe = {
      artikel: 0,
      geaendert: 0,
      bilderVorher: 0,
      bilderNachher: 0,
      unterschriftenVorher: 0,
      unterschriftenNachher: 0,
      ohneAnker: 0,
    };
    for (const eingabe of articles) {
      const artikel = await ctx.db.get(eingabe.articleId);
      if (!artikel || artikel.issueId !== issueId) {
        throw new Error(`Artikel ${eingabe.articleId} gehoert nicht zu dieser Ausgabe`);
      }
      const { bilder, flaechen } = await bilderUndFlaechen(ctx, eingabe.articleId);
      const bloecke = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article", (q) => q.eq("articleId", eingabe.articleId))
        .collect();
      const neu = eingabe.images.map((img, i) => {
        const anker = ankerFinden(bloecke, img.anchorText, img.afterBlockOrder);
        if (img.afterBlockOrder !== undefined && anker === undefined) summe.ohneAnker++;
        return {
          articleId: eingabe.articleId,
          issueId,
          assetId: img.assetId,
          order: i,
          caption: img.caption,
          sourcePageIndex: img.sourcePageIndex,
          sourceY: img.sourceY,
          afterBlockOrder: anker,
        };
      });
      summe.artikel++;
      summe.bilderVorher += bilder.length;
      summe.bilderNachher += neu.length;
      summe.unterschriftenVorher += bilder.filter((b) => b.caption).length;
      summe.unterschriftenNachher += neu.filter((b) => b.caption).length;
      const gleich =
        bilder.length === neu.length &&
        [...bilder]
          .sort((a, b) => a.order - b.order)
          .every((b, i) => (b.caption ?? "") === (neu[i].caption ?? "") && b.sourcePageIndex === neu[i].sourcePageIndex);
      if (!gleich) summe.geaendert++;
      if (probe) continue;
      for (const b of bilder) await ctx.db.delete(b._id);
      for (const f of flaechen) await ctx.db.delete(f._id);
      for (const zeile of neu) await ctx.db.insert("articleAssets", zeile);
      for (const f of eingabe.imageRegions) {
        await ctx.db.insert("articleRegions", {
          articleId: eingabe.articleId,
          issueId,
          kind: "image",
          ...f,
        });
      }
    }
    if (!probe) {
      console.log(JSON.stringify({ event: "bildnachtrag", issueId, ...summe }));
    }
    return summe;
  },
});

/** Alle Bildzeilen und Bildflaechen einer Ausgabe — die Sicherung vor dem Nachtrag. */
export const bestandInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const bilder = await ctx.db
      .query("articleAssets")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const flaechen = (
      await ctx.db
        .query("articleRegions")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .collect()
    ).filter((r) => r.kind === "image");
    return { issueId, bilder, flaechen };
  },
});

const gesicherteZeile = v.object({
  _id: v.optional(v.string()),
  _creationTime: v.optional(v.number()),
  articleId: v.id("articles"),
  issueId: v.id("issues"),
  assetId: v.id("assets"),
  order: v.number(),
  caption: v.optional(v.string()),
  sourcePageIndex: v.optional(v.number()),
  sourceY: v.optional(v.number()),
  afterBlockOrder: v.optional(v.number()),
});

const gesicherteFlaeche = v.object({
  _id: v.optional(v.string()),
  _creationTime: v.optional(v.number()),
  articleId: v.id("articles"),
  issueId: v.id("issues"),
  pageIndex: v.number(),
  ...regionBox,
  kind: v.literal("image"),
  targetPageIndex: v.optional(v.number()),
  order: v.optional(v.number()),
});

/**
 * Den Stand aus `bestandInternal` zuruecksetzen. Fuer jeden Artikel, der in
 * der Sicherung vorkommt, werden seine heutigen Bildzeilen und Bildflaechen
 * durch die gesicherten ersetzt. Artikel, die es nicht mehr gibt, werden
 * uebergangen und gezaehlt.
 */
export const wiederherstellenInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    bilder: v.array(gesicherteZeile),
    flaechen: v.array(gesicherteFlaeche),
    probelauf: v.optional(v.boolean()),
  },
  returns: v.object({
    artikel: v.number(),
    bilder: v.number(),
    flaechen: v.number(),
    fehlendeArtikel: v.number(),
    probelauf: v.boolean(),
  }),
  handler: async (ctx, { issueId, bilder, flaechen, probelauf }) => {
    const artikelIds = new Set<string>([
      ...bilder.map((b) => b.articleId),
      ...flaechen.map((f) => f.articleId),
    ]);
    let fehlend = 0;
    let artikel = 0;
    for (const id of artikelIds) {
      const doc = (await ctx.db.get(id as Id<"articles">)) as Doc<"articles"> | null;
      if (!doc || doc.issueId !== issueId) {
        fehlend++;
        continue;
      }
      artikel++;
      if (probelauf) continue;
      const heute = await bilderUndFlaechen(ctx, id as Id<"articles">);
      for (const b of heute.bilder) await ctx.db.delete(b._id);
      for (const f of heute.flaechen) await ctx.db.delete(f._id);
      for (const { _id, _creationTime, ...b } of bilder.filter((x) => x.articleId === id)) {
        await ctx.db.insert("articleAssets", b);
      }
      for (const { _id, _creationTime, ...f } of flaechen.filter((x) => x.articleId === id)) {
        await ctx.db.insert("articleRegions", f);
      }
    }
    return {
      artikel,
      bilder: bilder.filter((b) => artikelIds.has(b.articleId)).length,
      flaechen: flaechen.length,
      fehlendeArtikel: fehlend,
      probelauf: probelauf ?? false,
    };
  },
});
