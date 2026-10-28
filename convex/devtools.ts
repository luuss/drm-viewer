import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { slugify } from "./publications";
import { publishIssue } from "./issues";
import { audit, rolesOf } from "./roles";
import { rebuildSearchText } from "./articles";
import { deleteLinksForBlock } from "./articleProducts";
import { heftStueckeLoeschen, sucheVormerken } from "./suche";
import { textBereinigen, titelBereinigen } from "./textBereinigung";
import { erscheinungAusBezeichnung } from "./erscheinung";

/**
 * Hilfen fuer Entwicklung und Integrationspruefung.
 *
 * Diese Funktionen sind intern und nur ueber die Kommandozeile erreichbar. Sie
 * bauen einen Testbestand auf, ohne den Weg ueber die Oberflaeche zu gehen —
 * damit laesst sich die Pipeline mit echten Heften pruefen.
 */
const coverLayout = v.union(v.literal("sheets"), v.literal("spreads"));

export const seedIssueFromAssets = internalMutation({
  args: {
    publicationName: v.string(),
    // Kennung der Publikation; der Worker waehlt danach das Heftprofil. Ohne
    // Angabe wird sie aus dem Namen gebildet ("ZUERST!" wird zu "zuerst").
    publicationSlug: v.optional(v.string()),
    title: v.string(),
    issueNumber: v.optional(v.string()),
    description: v.optional(v.string()),
    publicationDate: v.optional(v.number()),
    priceAmountCents: v.number(),
    innerStorageId: v.id("_storage"),
    innerFilename: v.string(),
    innerPageCount: v.number(),
    coverStorageId: v.optional(v.id("_storage")),
    coverFilename: v.optional(v.string()),
    coverPageCount: v.optional(v.number()),
    // "sheets": vier Einzelseiten in Bogenreihenfolge (U4, U1, U2, U3).
    // "spreads": zwei Doppelseiten (U4|U1, U2|U3), gelesen als Haelften.
    // Ohne Angabe entscheidet die Seitenzahl der Umschlagdatei.
    coverLayout: v.optional(coverLayout),
    // Satzdateien (.indd) werden nur abgelegt, nicht ausgewertet. Innenteil
    // und Umschlag haben in der Regel je eine.
    archives: v.optional(
      v.array(v.object({ storageId: v.id("_storage"), filename: v.string() })),
    ),
    printedStart: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const slug = slugify(args.title);
    const publicationSlug = args.publicationSlug?.trim() || slugify(args.publicationName);

    let publication = await ctx.db
      .query("publications")
      .withIndex("by_slug", (q) => q.eq("slug", publicationSlug))
      .first();
    if (!publication) {
      const id = await ctx.db.insert("publications", {
        name: args.publicationName,
        slug: publicationSlug,
        isActive: true,
        createdAt: now,
      });
      publication = await ctx.db.get(id);
    }

    const issueId = await ctx.db.insert("issues", {
      publicationId: publication!._id,
      title: args.title,
      slug: `${slug}-${now.toString(36)}`,
      issueNumber: args.issueNumber,
      description: args.description,
      publicationDate: args.publicationDate,
      pageCount: 0,
      priceAmountCents: args.priceAmountCents,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });

    const innerAsset = await ctx.db.insert("assets", {
      key: `uploads/${issueId}/${args.innerFilename}`,
      contentType: "application/pdf",
      kind: "source",
      issueId,
      convexStorageId: args.innerStorageId,
      createdAt: now,
    });
    await ctx.db.insert("issueSources", {
      issueId,
      kind: "pdf",
      role: "inner",
      assetId: innerAsset,
      filename: args.innerFilename,
      pageCount: args.innerPageCount,
      sortOrder: 0,
      createdAt: now,
    });

    const coverPages = args.coverPageCount ?? (args.coverLayout === "spreads" ? 2 : 4);
    const layout = args.coverLayout ?? (coverPages === 2 ? "spreads" : "sheets");
    let coverAsset: Id<"assets"> | null = null;
    if (args.coverStorageId) {
      coverAsset = await ctx.db.insert("assets", {
        key: `uploads/${issueId}/${args.coverFilename ?? "umschlag.pdf"}`,
        contentType: "application/pdf",
        kind: "source",
        issueId,
        convexStorageId: args.coverStorageId,
        createdAt: now,
      });
      await ctx.db.insert("issueSources", {
        issueId,
        kind: "pdf",
        role: "cover",
        assetId: coverAsset,
        filename: args.coverFilename ?? "umschlag.pdf",
        pageCount: coverPages,
        sortOrder: 1,
        createdAt: now,
      });
    }

    for (const [index, archive] of (args.archives ?? []).entries()) {
      const assetId = await ctx.db.insert("assets", {
        key: `uploads/${issueId}/${archive.filename}`,
        contentType: "application/octet-stream",
        kind: "source",
        issueId,
        convexStorageId: archive.storageId,
        createdAt: now,
      });
      await ctx.db.insert("issueSources", {
        issueId,
        kind: "indd",
        role: "archive",
        assetId,
        filename: archive.filename,
        sortOrder: 2 + index,
        createdAt: now,
      });
    }

    // Vorschlag wie im Importdialog: Umschlag zu U1, U2, Innenteil, U3, U4.
    const pages: {
      sourceAssetId: Id<"assets">;
      sourcePageIndex: number;
      sourceHalf?: "left" | "right";
      role: "front_cover" | "inside_front" | "content" | "inside_back" | "back_cover";
      printedLabel?: string;
    }[] = [];
    const printedStart = args.printedStart ?? 3;
    const spreads = coverAsset !== null && layout === "spreads" && coverPages >= 2;
    const sheets = coverAsset !== null && layout === "sheets" && coverPages === 4;
    if (coverAsset && spreads) {
      // Erster Bogen: links U4, rechts U1. Zweiter Bogen: links U2, rechts U3.
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 0, sourceHalf: "right", role: "front_cover", printedLabel: "U1" });
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 1, sourceHalf: "left", role: "inside_front", printedLabel: "U2" });
    } else if (coverAsset && sheets) {
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 1, role: "front_cover", printedLabel: "U1" });
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 2, role: "inside_front", printedLabel: "U2" });
    }
    for (let i = 0; i < args.innerPageCount; i++) {
      pages.push({
        sourceAssetId: innerAsset,
        sourcePageIndex: i,
        role: "content",
        printedLabel: String(printedStart + i),
      });
    }
    if (coverAsset && spreads) {
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 1, sourceHalf: "right", role: "inside_back", printedLabel: "U3" });
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 0, sourceHalf: "left", role: "back_cover", printedLabel: "U4" });
    } else if (coverAsset && sheets) {
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 3, role: "inside_back", printedLabel: "U3" });
      pages.push({ sourceAssetId: coverAsset, sourcePageIndex: 0, role: "back_cover", printedLabel: "U4" });
    }

    let index = 0;
    for (const p of pages) {
      await ctx.db.insert("issuePages", {
        issueId,
        index: index++,
        printedLabel: p.printedLabel,
        role: p.role,
        sourceAssetId: p.sourceAssetId,
        sourcePageIndex: p.sourcePageIndex,
        sourceHalf: p.sourceHalf,
        width: 0,
        height: 0,
      });
    }
    await ctx.db.patch(issueId, { pageCount: pages.length });

    const jobId = await ctx.db.insert("importJobs", {
      issueId,
      kind: "full",
      status: "queued",
      attempts: 0,
      createdAt: now,
    });
    return { issueId, jobId, pages: pages.length, publicationSlug };
  },
});

/**
 * Alle offenen Artikel freigeben und die Ausgabe veroeffentlichen. Fuer das
 * Anlegen von der Kommandozeile (`heft-anlegen.py --freigeben`); die
 * redaktionelle Pruefung entfaellt damit bewusst.
 */
export const releaseIssueInternal = internalMutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    let approved = 0;
    for (const row of rows) {
      if (row.reviewStatus !== "pending") continue;
      await ctx.db.patch(row._id, { reviewStatus: "approved", updatedAt: Date.now() });
      approved++;
    }
    await audit(ctx, "article.approveAll", issueId, `${approved} Artikel (Kommandozeile)`);
    await publishIssue(ctx, issueId);
    const issue = await ctx.db.get(issueId);
    return { approved, articles: rows.length, slug: issue?.slug ?? null };
  },
});

/** Ausgabe aus dem Kiosk nehmen oder wieder hineinstellen, von der Kommandozeile. */
export const setPublishedInternal = internalMutation({
  args: { issueId: v.id("issues"), isPublished: v.boolean() },
  handler: async (ctx, { issueId, isPublished }) => {
    if (isPublished) {
      await publishIssue(ctx, issueId);
    } else {
      const issue = await ctx.db.get(issueId);
      if (!issue) throw new Error("Ausgabe nicht gefunden");
      await ctx.db.patch(issueId, { isPublished: false, updatedAt: Date.now() });
      await audit(ctx, "issue.unpublish", issueId, "Kommandozeile");
      await heftStueckeLoeschen(ctx, issueId);
    }
    const issue = await ctx.db.get(issueId);
    return { title: issue?.title ?? null, isPublished: issue?.isPublished ?? null };
  },
});

/** Artikelentwuerfe einer Ausgabe, um ein Importergebnis von aussen zu pruefen. */
export const articlesInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    return rows.map((a) => ({
      order: a.order,
      title: a.title,
      subtitle: a.subtitle ?? null,
      pageStart: a.pageStart,
      pageEnd: a.pageEnd,
      chars: a.searchText.length,
      reviewStatus: a.reviewStatus,
    }));
  },
});

/** Einen Artikel nach dem Import ausschliessen oder freigeben, von der Kommandozeile. */
export const setArticleStatusInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    order: v.number(),
    reviewStatus: v.union(v.literal("approved"), v.literal("excluded"), v.literal("pending")),
  },
  handler: async (ctx, { issueId, order, reviewStatus }) => {
    const article = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId).eq("order", order))
      .unique();
    if (!article) throw new Error(`Kein Artikel mit Nummer ${order}`);
    await ctx.db.patch(article._id, { reviewStatus, updatedAt: Date.now() });
    await sucheVormerken(ctx, issueId, article._id);
    await audit(ctx, "article.setReviewStatus", article._id, `${reviewStatus} (Kommandozeile)`);
    return { title: article.title, reviewStatus };
  },
});

/**
 * Bilder aus bestehenden Artikeln nehmen, ohne Neuimport — der verwuerfe die
 * Freigaben der Redaktion. Gedacht fuer Hefte, die eingelesen wurden, bevor
 * der Worker doppelte Bilder und Schmuckrahmen selbst aussortierte. Welche
 * Zeilen das sind, rechnet dieselbe Auswertung wie beim Import aus.
 *
 * `captionTo` nennt das Bild, das stehen bleibt: hat es noch keine
 * Bildunterschrift, erbt es die des entfernten. Die Bilddateien selbst
 * bleiben im Medienspeicher liegen.
 */
/**
 * Text einer Ausgabe nachbessern, ohne Neuimport (convex/textBereinigung.ts):
 * Strich vor Woertern, Doppelstrich, Eurozeichen als "t", Symbolzeichen,
 * abgesetzte Akzente, umbrochene Titelzeilen. Betrifft Absaetze und
 * Tabellenzellen, Titel, Untertitel, Autor, Vorspann, Bildunterschriften und
 * Verzeichniseintraege. Freigaben bleiben; der Suchtext wird neu gebildet.
 * Mit `probelauf` wird nur gezaehlt und gezeigt.
 */
export const textBereinigenInternal = internalMutation({
  args: { issueId: v.id("issues"), probelauf: v.optional(v.boolean()) },
  returns: v.object({
    bloecke: v.number(),
    artikel: v.number(),
    unterschriften: v.number(),
    verzeichnis: v.number(),
    beispiele: v.array(v.string()),
    probelauf: v.boolean(),
  }),
  handler: async (ctx, { issueId, probelauf }) => {
    const nurZaehlen = probelauf ?? false;
    const beispiele: string[] = [];
    const merken = (alt: string, neu: string) => {
      if (beispiele.length < 25) beispiele.push(`${alt.slice(0, 90)} => ${neu.slice(0, 90)}`);
    };
    const geaendert = new Set<Id<"articles">>();
    let bloecke = 0;
    let artikelZahl = 0;
    let unterschriften = 0;
    let verzeichnis = 0;

    const artikel = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const a of artikel) {
      const patch: Record<string, string> = {};
      const felder = [
        ["title", titelBereinigen],
        ["subtitle", titelBereinigen],
        ["author", textBereinigen],
        ["teaser", textBereinigen],
      ] as const;
      for (const [feld, regel] of felder) {
        const alt = a[feld];
        if (!alt) continue;
        const neu = regel(alt);
        if (neu !== alt && neu) {
          patch[feld] = neu;
          merken(alt, neu);
        }
      }
      if (Object.keys(patch).length) {
        artikelZahl++;
        geaendert.add(a._id);
        if (!nurZaehlen) await ctx.db.patch(a._id, patch);
      }

      const rows = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article", (q) => q.eq("articleId", a._id))
        .collect();
      for (const b of rows) {
        const text = textBereinigen(b.text);
        let table = b.table;
        let tabelleNeu = false;
        if (table) {
          const zeilen = table.rows.map((zeile) =>
            zeile.map((zelle) => {
              const t = textBereinigen(zelle.text);
              if (t !== zelle.text) tabelleNeu = true;
              return { ...zelle, text: t };
            }),
          );
          if (tabelleNeu) table = { ...table, rows: zeilen };
        }
        if (text === b.text && !tabelleNeu) continue;
        bloecke++;
        geaendert.add(a._id);
        if (text !== b.text) merken(b.text, text);
        if (!nurZaehlen) await ctx.db.patch(b._id, { text, ...(tabelleNeu ? { table } : {}) });
      }

      const bilder = await ctx.db
        .query("articleAssets")
        .withIndex("by_article", (q) => q.eq("articleId", a._id))
        .collect();
      for (const bild of bilder) {
        if (!bild.caption) continue;
        const neu = textBereinigen(bild.caption);
        if (neu === bild.caption) continue;
        unterschriften++;
        merken(bild.caption, neu);
        if (!nurZaehlen) await ctx.db.patch(bild._id, { caption: neu || undefined });
      }
    }

    const eintraege = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const t of eintraege) {
      const neu = titelBereinigen(t.label);
      if (neu === t.label || !neu) continue;
      verzeichnis++;
      merken(t.label, neu);
      if (!nurZaehlen) await ctx.db.patch(t._id, { label: neu });
    }

    if (!nurZaehlen) {
      for (const id of geaendert) await rebuildSearchText(ctx, id);
      if (geaendert.size || unterschriften || verzeichnis) {
        await audit(
          ctx,
          "issue.textBereinigen",
          issueId,
          `${bloecke} Absaetze, ${artikelZahl} Artikel, ${unterschriften} Unterschriften, ${verzeichnis} Verzeichniseintraege (Kommandozeile)`,
        );
      }
    }
    return {
      bloecke,
      artikel: artikelZahl,
      unterschriften,
      verzeichnis,
      beispiele,
      probelauf: nurZaehlen,
    };
  },
});

/**
 * Erscheinungsdatum fuer Hefte nachtragen, die keins haben, aus den Angaben
 * des Ladens (shopDesignation, shopSubtitle, shopTitle). Ein gesetztes Datum
 * bleibt. Mit `probelauf` wird nur gezeigt, was gesetzt wuerde.
 */
export const erscheinungNachtragenInternal = internalMutation({
  args: { probelauf: v.optional(v.boolean()) },
  returns: v.array(
    v.object({ heft: v.string(), datum: v.union(v.string(), v.null()), quelle: v.string() }),
  ),
  handler: async (ctx, { probelauf }) => {
    const out = [];
    for await (const issue of ctx.db.query("issues")) {
      if (issue.publicationDate) continue;
      const datum = erscheinungAusBezeichnung(
        issue.shopDesignation,
        issue.shopSubtitle,
        issue.shopTitle,
      );
      out.push({
        heft: issue.title,
        datum: datum ? new Date(datum).toISOString().slice(0, 10) : null,
        quelle: [issue.shopDesignation, issue.shopSubtitle].filter(Boolean).join(" / "),
      });
      if (datum && !probelauf) {
        await ctx.db.patch(issue._id, { publicationDate: datum, updatedAt: Date.now() });
      }
    }
    if (!probelauf && out.some((o) => o.datum)) {
      await audit(ctx, "issue.erscheinungNachtragen", "issues", `${out.filter((o) => o.datum).length} Hefte (Kommandozeile)`);
    }
    return out;
  },
});

export const removeArticleImagesInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    remove: v.array(
      v.object({
        id: v.id("articleAssets"),
        captionTo: v.optional(v.id("articleAssets")),
      }),
    ),
    probelauf: v.optional(v.boolean()),
  },
  returns: v.object({
    removed: v.number(),
    captionsMoved: v.number(),
    articles: v.number(),
    probelauf: v.boolean(),
  }),
  handler: async (ctx, { issueId, remove, probelauf }) => {
    const weg = new Set<string>(remove.map((r) => r.id));
    const betroffen = new Set<Id<"articles">>();
    let removed = 0;
    let captionsMoved = 0;
    for (const { id, captionTo } of remove) {
      const row = await ctx.db.get(id);
      // Wiederholbar: was schon fehlt, ist erledigt.
      if (!row) continue;
      if (row.issueId !== issueId) {
        throw new Error(`Bild ${id} gehoert nicht zu dieser Ausgabe`);
      }
      if (captionTo) {
        const ziel = await ctx.db.get(captionTo);
        if (!ziel || ziel.articleId !== row.articleId || weg.has(captionTo)) {
          throw new Error(`Bild ${captionTo} bleibt nicht im selben Artikel stehen`);
        }
        if (row.caption && !ziel.caption) {
          if (!probelauf) await ctx.db.patch(captionTo, { caption: row.caption });
          captionsMoved++;
        }
      }
      if (!probelauf) await ctx.db.delete(id);
      betroffen.add(row.articleId);
      removed++;
    }
    if (!probelauf) {
      // Die Reihenfolge bleibt lueckenlos, wie der Import sie anlegt.
      for (const articleId of betroffen) {
        const rest = await ctx.db
          .query("articleAssets")
          .withIndex("by_article", (q) => q.eq("articleId", articleId))
          .collect();
        rest.sort((a, b) => a.order - b.order);
        for (const [i, r] of rest.entries()) {
          if (r.order !== i) await ctx.db.patch(r._id, { order: i });
        }
      }
      if (removed > 0) {
        await audit(
          ctx,
          "article.removeImages",
          issueId,
          `${removed} Bilder in ${betroffen.size} Artikeln (Kommandozeile)`,
        );
      }
    }
    return {
      removed,
      captionsMoved,
      articles: betroffen.size,
      probelauf: probelauf === true,
    };
  },
});

/**
 * Absaetze aus bestehenden Artikeln nehmen, ohne Neuimport — der verwuerfe die
 * Freigaben der Redaktion. Gedacht fuer Hefte, die eingelesen wurden, bevor
 * der Import Schmuckzitate und Seitenrubriken aus dem Fliesstext hielt: die
 * Zunge am Seitenrand ("Russische Panzerkorps schwer angeschlagen") stand als
 * loser Halbsatz zwischen zwei Absaetzen. Welche Absaetze das sind, rechnet
 * dieselbe Auswertung wie beim Import aus.
 *
 * Die Reihenfolge bleibt lueckenlos. Ein Bild, das hinter einem entfernten
 * Absatz verankert war, rueckt hinter den Absatz davor. Steht der auf einer
 * anderen Seite, faellt der Anker weg — der Leser setzt Bilder seitenweise
 * und ordnet es dann nach seiner Hoehe ein.
 */
export const removeArticleBlocksInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    remove: v.array(v.id("articleBlocks")),
    probelauf: v.optional(v.boolean()),
  },
  returns: v.object({
    removed: v.number(),
    articles: v.number(),
    imagesMoved: v.number(),
    probelauf: v.boolean(),
  }),
  handler: async (ctx, { issueId, remove, probelauf }) => {
    const weg = new Set<Id<"articleBlocks">>();
    const betroffen = new Set<Id<"articles">>();
    for (const id of remove) {
      const row = await ctx.db.get(id);
      // Wiederholbar: was schon fehlt, ist erledigt.
      if (!row) continue;
      if (row.issueId !== issueId) {
        throw new Error(`Absatz ${id} gehoert nicht zu dieser Ausgabe`);
      }
      weg.add(id);
      betroffen.add(row.articleId);
    }

    let imagesMoved = 0;
    for (const articleId of betroffen) {
      const article = await ctx.db.get(articleId);
      const seite = (s: number | undefined) => s ?? article?.pageStart;
      const bloecke = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
        .collect();
      const bilder = await ctx.db
        .query("articleAssets")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .collect();
      for (const bild of bilder) {
        // Der Anker zaehlt die Stelle im Artikel, so wie der Leser ihn liest.
        const anker = bild.afterBlockOrder;
        if (anker === undefined || anker <= 0) continue;
        const davor = bloecke.slice(0, anker);
        const rest = davor.filter((b) => !weg.has(b._id));
        if (rest.length === davor.length) continue;
        const halt = rest.at(-1);
        const ankerBleibt = !weg.has(davor[davor.length - 1]._id);
        const neu =
          halt &&
          (ankerBleibt || seite(halt.sourcePageIndex) === seite(bild.sourcePageIndex))
            ? rest.length
            : undefined;
        if (!probelauf) await ctx.db.patch(bild._id, { afterBlockOrder: neu });
        imagesMoved++;
      }
      if (probelauf) continue;
      let order = 1;
      for (const b of bloecke) {
        if (weg.has(b._id)) {
          await deleteLinksForBlock(ctx, b._id);
          await ctx.db.delete(b._id);
          continue;
        }
        if (b.order !== order) await ctx.db.patch(b._id, { order });
        order++;
      }
      await rebuildSearchText(ctx, articleId);
    }
    if (!probelauf && weg.size > 0) {
      await audit(
        ctx,
        "article.removeBlocks",
        issueId,
        `${weg.size} Absaetze in ${betroffen.size} Artikeln (Kommandozeile)`,
      );
    }
    return {
      removed: weg.size,
      articles: betroffen.size,
      imagesMoved,
      probelauf: probelauf === true,
    };
  },
});

/** Die juengsten Importauftraege, um den Worker von aussen zu beobachten. */
export const recentJobsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db.query("importJobs").order("desc").take(8);
    return jobs.map((job) => ({
      _id: job._id,
      issueId: job.issueId,
      status: job.status,
      progress: job.progress ?? null,
      message: job.message ?? null,
      workerId: job.workerId ?? null,
      attempts: job.attempts,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt ?? null,
    }));
  },
});

/**
 * Rolle setzen, ohne den Umweg ueber die Oberflaeche. Mit `create` wird ein
 * fehlendes Konto angelegt; die erste Anmeldung per E-Mail-Link findet es
 * ueber die Adresse (magicLink.userForEmail) und uebernimmt es.
 */
export const setRolesByEmail = internalMutation({
  args: { email: v.string(), roles: v.array(v.string()), create: v.optional(v.boolean()) },
  handler: async (ctx, { email, roles, create }) => {
    const adresse = email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", adresse))
      .first();
    if (!user) {
      if (!create) return { ok: false };
      const userId = await ctx.db.insert("users", { email: adresse, roles });
      await audit(ctx, "user.setRoles", userId, `${roles.join(",")} (Kommandozeile, neu)`);
      return { ok: true, userId, created: true };
    }
    await ctx.db.patch(user._id, { roles } as any);
    // Wie in der Oberflaeche protokollieren, sonst ist spaeter nicht zu
    // klaeren, woher eine Rolle kam.
    await audit(ctx, "user.setRoles", user._id, `${roles.join(",")} (Kommandozeile)`);
    return { ok: true, userId: user._id };
  },
});

/** Freischaltung fuer Tests. */
export const grantByEmailInternal = internalMutation({
  args: { email: v.string(), issueId: v.id("issues") },
  handler: async (ctx, { email, issueId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.toLowerCase()))
      .first();
    if (!user) return { ok: false };
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_issue", (q) =>
        q.eq("userId", user._id as Id<"users">).eq("issueId", issueId),
      )
      .first();
    if (existing) return { ok: true, existing: true };
    await ctx.db.insert("entitlements", {
      userId: user._id as Id<"users">,
      issueId,
      source: "admin",
      createdAt: Date.now(),
    });
    return { ok: true, existing: false };
  },
});

/**
 * Alle veroeffentlichten Hefte fuer ein Konto freischalten, von der
 * Kommandozeile. Schon vorhandene Freischaltungen bleiben, wie sie sind.
 */
export const grantAllPublishedByEmailInternal = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.trim().toLowerCase()))
      .first();
    if (!user) return { ok: false, grund: "Kein Konto mit dieser Adresse" };
    const neu: string[] = [];
    const schon: string[] = [];
    for await (const issue of ctx.db.query("issues")) {
      if (!issue.isPublished) continue;
      const existing = await ctx.db
        .query("entitlements")
        .withIndex("by_user_issue", (q) =>
          q.eq("userId", user._id as Id<"users">).eq("issueId", issue._id),
        )
        .first();
      if (existing) {
        schon.push(issue.title);
        continue;
      }
      await ctx.db.insert("entitlements", {
        userId: user._id as Id<"users">,
        issueId: issue._id,
        source: "admin",
        createdAt: Date.now(),
      });
      await audit(ctx, "entitlement.grant", issue._id, `${email} (Kommandozeile)`);
      neu.push(issue.title);
    }
    return { ok: true, neu, schon };
  },
});

/**
 * Konten zu einem Teil der Adresse mit ihren Rechten, zur Pruefung von der
 * Kommandozeile: gespeicherte Rollen, was daraus folgt, ob die Adresse in
 * ADMIN_EMAILS steht, und wie viele Sitzungen offen sind.
 */
export const usersByEmailPartInternal = internalQuery({
  args: { teil: v.string() },
  handler: async (ctx, { teil }) => {
    const such = teil.trim().toLowerCase();
    const admins = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const out = [];
    for await (const u of ctx.db.query("users")) {
      const email = (u.email ?? "").toLowerCase();
      if (!email.includes(such)) continue;
      const sitzungen = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", u._id))
        .collect();
      out.push({
        userId: u._id,
        email: u.email ?? null,
        gespeicherteRollen: Array.isArray((u as any).roles) ? (u as any).roles : [],
        wirksameRollen: rolesOf(u),
        inAdminEmails: admins.includes(email),
        offeneSitzungen: sitzungen.length,
      });
    }
    return out;
  },
});

/** Stand eines Importauftrags, fuer Skripte, die auf den Worker warten. */
export const jobStatusInternal = internalQuery({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    const issue = await ctx.db.get(job.issueId);
    return {
      status: job.status,
      progress: job.progress ?? null,
      message: job.message ?? null,
      attempts: job.attempts,
      issueId: job.issueId,
      issueSlug: issue?.slug ?? null,
      pageCount: issue?.pageCount ?? null,
      articleCount: issue?.articleCount ?? null,
    };
  },
});

/** Auftrag zuruecksetzen, wenn ein Fehler behoben wurde. */
export const requeueJob = internalMutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    await ctx.db.patch(jobId, {
      status: "queued",
      attempts: 0,
      message: undefined,
      leaseUntil: undefined,
      workerId: undefined,
      progress: 0,
    });
    return { ok: true };
  },
});

/** Konten mit Rollen auflisten, wahlweise nach einem Teil der Adresse. */
export const usersWithRolesInternal = internalQuery({
  args: { suche: v.optional(v.string()) },
  handler: async (ctx, { suche }) => {
    const teil = (suche ?? "").trim().toLowerCase();
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => !teil || (u.email ?? "").toLowerCase().includes(teil) || ((u as any).name ?? "").toLowerCase().includes(teil))
      .map((u) => ({ email: u.email ?? null, name: (u as any).name ?? null, roles: rolesOf(u) }))
      .filter((u) => !!teil || u.roles.some((r) => r !== "customer"));
  },
});
