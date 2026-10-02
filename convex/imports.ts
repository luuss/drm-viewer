import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, audit } from "./roles";
import { articleInput } from "./articles";
import type { Infer } from "convex/values";
import { deleteLinksForBlock, deleteLinksForIssue } from "./articleProducts";
import { pageLinkInput, replaceImportedLinks } from "./pageLinks";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/** Wie lange ein Worker einen Auftrag fuer sich behalten darf. */
const LEASE_MS = Number(process.env.IMPORT_LEASE_MS ?? String(10 * 60 * 1000));
const MAX_ATTEMPTS = Number(process.env.IMPORT_MAX_ATTEMPTS ?? "3");

export const jobKind = v.union(
  v.literal("prepare"),
  v.literal("pdf"),
  v.literal("idml"),
  v.literal("full"),
  // Nur die Klickflaechen des gedruckten Inhaltsverzeichnisses neu legen;
  // Artikel und Freigaben bleiben stehen (activateTocRegionsInternal).
  v.literal("toc"),
  // Den Satz neu lesen und nur die Artikel einsetzen oder ersetzen, die sich
  // dabei aendern (mergeResultInternal). Alles andere bleibt stehen, auch
  // Freigaben. Mit payload "probe" wird nur gezaehlt.
  v.literal("nachtrag"),
);

type JobKind = "prepare" | "pdf" | "idml" | "full" | "toc" | "nachtrag";

async function queueJob(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  kind: JobKind,
  payload: string | undefined,
  userId: Id<"users"> | undefined,
) {
  const open = await ctx.db
    .query("importJobs")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const running = open.find(
    (j) => j.status === "queued" || j.status === "claimed" || j.status === "running",
  );
  if (running) {
    throw new Error("Für diese Ausgabe läuft bereits ein Auftrag");
  }
  return await ctx.db.insert("importJobs", {
    issueId,
    kind,
    status: "queued",
    payload,
    attempts: 0,
    createdByUserId: userId,
    createdAt: Date.now(),
  });
}

/**
 * Auftrag einstellen. Die Verarbeitung laeuft in einem eigenen Worker; die
 * Warteschlange liegt in der Datenbank, damit ein Neustart nichts verliert.
 */
export const enqueue = mutation({
  args: { issueId: v.id("issues"), kind: jobKind, payload: v.optional(v.string()) },
  handler: async (ctx, { issueId, kind, payload }) => {
    await requireEditor(ctx);
    const userId = await getAuthUserId(ctx);
    const id = await queueJob(
      ctx,
      issueId,
      kind,
      payload,
      (userId as Id<"users">) ?? undefined,
    );
    await audit(ctx, "import.enqueue", issueId, kind);
    return id;
  },
});

/** Auftrag ohne Anmeldung — fuer Werkzeuge mit Deploy-Schluessel (`npx convex run`). */
export const enqueueInternal = internalMutation({
  args: { issueId: v.id("issues"), kind: jobKind, payload: v.optional(v.string()) },
  handler: async (ctx, { issueId, kind, payload }) =>
    await queueJob(ctx, issueId, kind, payload, undefined),
});

export const listForIssue = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    return await ctx.db
      .query("importJobs")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .order("desc")
      .take(10);
  },
});

export const cancel = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    await requireEditor(ctx);
    await ctx.db.patch(jobId, {
      status: "error",
      message: "Von der Redaktion abgebrochen",
      finishedAt: Date.now(),
    });
  },
});

export const retry = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    await requireEditor(ctx);
    await ctx.db.patch(jobId, {
      status: "queued",
      message: undefined,
      leaseUntil: undefined,
      workerId: undefined,
      progress: 0,
    });
  },
});

// --- Worker-Schnittstelle (nur ueber die Dienst-Endpunkte erreichbar) ---

/**
 * Holt genau einen Auftrag und sperrt ihn. Abgelaufene Sperren werden dabei
 * wieder freigegeben, damit ein abgestuerzter Worker nichts blockiert.
 */
export const claimNextInternal = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, { workerId }) => {
    const now = Date.now();

    for (const status of ["claimed", "running"] as const) {
      const stuck = await ctx.db
        .query("importJobs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const job of stuck) {
        if ((job.leaseUntil ?? 0) < now) {
          const failed = job.attempts >= MAX_ATTEMPTS;
          await ctx.db.patch(job._id, {
            status: failed ? "error" : "queued",
            message: failed
              ? `Abgebrochen nach ${job.attempts} Versuchen ohne Lebenszeichen`
              : "Sperre abgelaufen, wird erneut versucht",
            leaseUntil: undefined,
            workerId: undefined,
            finishedAt: failed ? now : undefined,
          });
        }
      }
    }

    const queued = await ctx.db
      .query("importJobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .first();
    if (!queued) return null;

    await ctx.db.patch(queued._id, {
      status: "claimed",
      workerId,
      leaseUntil: now + LEASE_MS,
      attempts: queued.attempts + 1,
      startedAt: queued.startedAt ?? now,
      message: "Vom Worker übernommen",
    });

    const issue = await ctx.db.get(queued.issueId);
    const publication = issue ? await ctx.db.get(issue.publicationId) : null;
    const sources = await ctx.db
      .query("issueSources")
      .withIndex("by_issue", (q) => q.eq("issueId", queued.issueId))
      .collect();
    const pages = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", queued.issueId))
      .collect();

    const sourceInfos = [];
    for (const s of sources) {
      const asset = await ctx.db.get(s.assetId);
      if (!asset) continue;
      sourceInfos.push({
        sourceId: s._id,
        kind: s.kind,
        role: s.role,
        assetId: s.assetId,
        assetKey: asset.key,
        filename: s.filename,
        url: asset.convexStorageId
          ? await ctx.storage.getUrl(asset.convexStorageId)
          : null,
      });
    }

    // Seiten, die der Browser schon gerendert hat, reicht der Worker nur durch.
    // Er braucht sie fuer die Ausschnitte der Artikelbilder und bekommt dafuer
    // gleich die Adresse mit.
    const pageInfos = [];
    for (const p of pages) {
      let previewUrl: string | null = null;
      if (p.previewKey) {
        const asset = await ctx.db
          .query("assets")
          .withIndex("by_key", (q) => q.eq("key", p.previewKey!))
          .first();
        previewUrl = asset?.convexStorageId
          ? await ctx.storage.getUrl(asset.convexStorageId)
          : null;
      }
      pageInfos.push({
        index: p.index,
        sourceAssetId: p.sourceAssetId,
        sourcePageIndex: p.sourcePageIndex,
        sourceHalf: p.sourceHalf ?? null,
        role: p.role,
        printedLabel: p.printedLabel ?? null,
        previewKey: p.previewKey ?? null,
        previewUrl,
      });
    }

    return {
      jobId: queued._id,
      issueId: queued.issueId,
      publicationId: issue?.publicationId ?? null,
      publicationSlug: publication?.slug ?? null,
      publicationName: publication?.name ?? null,
      kind: queued.kind,
      payload: queued.payload ?? null,
      attempts: queued.attempts + 1,
      sources: sourceInfos,
      pages: pageInfos,
    };
  },
});

export const heartbeatInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    workerId: v.string(),
    progress: v.optional(v.number()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, workerId, progress, message }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return { ok: false, reason: "unknown" };
    if (job.workerId && job.workerId !== workerId) {
      // Ein anderer Worker hat uebernommen; dieser soll aufhoeren.
      return { ok: false, reason: "lease_lost" };
    }
    await ctx.db.patch(jobId, {
      status: "running",
      progress,
      message,
      leaseUntil: Date.now() + LEASE_MS,
    });
    return { ok: true };
  },
});

export const finishInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    workerId: v.string(),
    status: v.union(v.literal("review"), v.literal("done"), v.literal("error")),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, workerId, status, message }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return { ok: false };
    if (job.workerId && job.workerId !== workerId) return { ok: false };
    const failedTooOften = status === "error" && job.attempts >= MAX_ATTEMPTS;
    await ctx.db.patch(jobId, {
      status: status === "error" && !failedTooOften ? "queued" : status,
      message,
      progress: status === "error" ? job.progress : 100,
      leaseUntil: undefined,
      workerId: undefined,
      finishedAt: status === "error" && !failedTooOften ? undefined : Date.now(),
    });
    return { ok: true, requeued: status === "error" && !failedTooOften };
  },
});

export const getInternal = internalQuery({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => await ctx.db.get(jobId),
});

/**
 * Nur die Klickflaechen des gedruckten Inhaltsverzeichnisses ersetzen.
 *
 * Der Auftrag `toc` legt sie neu, etwa nachdem die Textebene zu einem schon
 * importierten Heft nachgetragen wurde. Artikel, Bloecke, Freigaben und
 * Verknuepfungen bleiben unberuehrt. Jede Flaeche haengt am Artikel, der auf
 * der Zielseite beginnt: ueber den Verzeichniseintrag, sonst ueber den
 * Seitenanfang. Findet sich keiner, faellt die Flaeche weg.
 */
export const activateTocRegionsInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    workerId: v.string(),
    issueId: v.id("issues"),
    regions: v.array(
      v.object({
        pageIndex: v.number(),
        x0: v.number(),
        y0: v.number(),
        x1: v.number(),
        y1: v.number(),
        targetPageIndex: v.number(),
        label: v.optional(v.string()),
      }),
    ),
    // Eintraege des gedruckten Verzeichnisses, die im Heft noch fehlen
    // (etwa Rubrikzeilen mit Seitenzahl, die ein aelterer Import nicht
    // kannte). Vorhandene und von der Redaktion bearbeitete bleiben.
    entries: v.optional(
      v.array(
        v.object({
          label: v.string(),
          pageIndex: v.number(),
          section: v.optional(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, { jobId, workerId, issueId, regions, entries }) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Auftrag unbekannt");
    if (job.issueId !== issueId) throw new Error("Auftrag passt nicht zur Ausgabe");
    if (job.workerId && job.workerId !== workerId) {
      throw new Error("Sperre liegt bei einem anderen Worker");
    }

    const alt = await ctx.db
      .query("articleRegions")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const r of alt) {
      if (r.targetPageIndex !== undefined) await ctx.db.delete(r._id);
    }

    const articles = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    articles.sort((a, b) => a.order - b.order);
    const vorhanden = new Set(articles.map((a) => a._id as string));
    const toc = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const ziele = new Set(regions.map((r) => r.targetPageIndex));
    const artikelAb = (pageIndex: number): Id<"articles"> | undefined => {
      const eintrag = toc.find(
        (t) =>
          t.pageIndex === pageIndex &&
          t.articleId !== undefined &&
          vorhanden.has(t.articleId as string),
      );
      if (eintrag?.articleId) return eintrag.articleId;
      return articles.find((a) => a.pageStart === pageIndex)?._id;
    };
    const zielArtikel = (pageIndex: number): Id<"articles"> | undefined => {
      const genau = artikelAb(pageIndex);
      // Aufmacherseite: das Verzeichnis nennt die Seite mit Bild und Titel,
      // der Text der Story beginnt erst auf der naechsten. Die Folgeseite
      // zaehlt nur, wenn kein eigener Eintrag auf sie zeigt.
      if (genau || ziele.has(pageIndex + 1)) return genau;
      return artikelAb(pageIndex + 1);
    };

    let eingetragen = 0;
    let uebergangen = 0;
    for (const [i, r] of regions.entries()) {
      const articleId = zielArtikel(r.targetPageIndex);
      if (!articleId) {
        uebergangen++;
        continue;
      }
      await ctx.db.insert("articleRegions", {
        articleId,
        issueId,
        pageIndex: r.pageIndex,
        x0: r.x0,
        y0: r.y0,
        x1: r.x1,
        y1: r.y1,
        kind: "other",
        targetPageIndex: r.targetPageIndex,
        order: i,
      });
      eingetragen++;
    }
    let neueEintraege = 0;
    if (entries?.length) {
      const vorhandene = toc.map((t) => ({
        id: t._id,
        pageIndex: t.pageIndex,
        label: t.label.trim().toLowerCase(),
      }));
      for (const e of entries) {
        const label = e.label.trim();
        const klein = label.toLowerCase();
        // Derselbe Eintrag, wenn ein Text den anderen enthaelt: ein frueherer
        // Import kannte nur die zweite Zeile ("statt Strafpsychiatrie"), der
        // Satz nennt jetzt beide. Dann waechst der Eintrag, statt sich zu verdoppeln.
        const gleich = vorhandene.find(
          (v) =>
            v.pageIndex === e.pageIndex &&
            (v.label === klein || klein.includes(v.label) || v.label.includes(klein)),
        );
        if (gleich) {
          if (klein.length > gleich.label.length) {
            await ctx.db.patch(gleich.id, { label: label.slice(0, 300) });
            gleich.label = klein;
          }
          continue;
        }
        await ctx.db.insert("tocEntries", {
          issueId,
          order: 0,
          label: label.slice(0, 300),
          section: e.section,
          pageIndex: e.pageIndex,
          articleId: zielArtikel(e.pageIndex),
          level: 1,
        });
        vorhandene.push({ id: undefined as any, pageIndex: e.pageIndex, label: klein });
        neueEintraege++;
      }
      if (neueEintraege) {
        // Alle Eintraege nach Seite reihen; Reihenfolge innerhalb einer Seite bleibt.
        const alle = await ctx.db
          .query("tocEntries")
          .withIndex("by_issue", (q) => q.eq("issueId", issueId))
          .collect();
        alle.sort(
          (a, b) =>
            (a.pageIndex ?? 0) - (b.pageIndex ?? 0) ||
            (a.order || Infinity) - (b.order || Infinity),
        );
        for (const [i, t] of alle.entries()) {
          if (t.order !== i + 1) await ctx.db.patch(t._id, { order: i + 1 });
        }
      }
    }
    await ctx.db.patch(issueId, { updatedAt: Date.now() });
    console.log(
      JSON.stringify({
        event: "import.tocRegions",
        issueId,
        regions: eingetragen,
        skipped: uebergangen,
        entries: neueEintraege,
      }),
    );
    return { regions: eingetragen, skipped: uebergangen, entries: neueEintraege };
  },
});

/**
 * Uebernimmt das Ergebnis eines Laufs in einem Zug.
 *
 * Alles aus den Quellen Abgeleitete wird ersetzt: Artikel, Bloecke, Regionen,
 * Artikelbilder und das automatisch erzeugte Inhaltsverzeichnis. Da eine
 * Convex-Mutation eine Transaktion ist, sehen Leser entweder den alten oder den
 * neuen Stand — nie eine Mischung. Quellen, Stammdaten, Kaeufe und
 * Freischaltungen bleiben unberuehrt.
 */
type ArticleInput = Infer<typeof articleInput>;

/** Einen Artikel samt Absaetzen, Flaechen und Bildern anlegen. */
async function insertArticle(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  a: ArticleInput,
  reviewStatus: "pending" | "approved",
  now: number,
): Promise<Id<"articles">> {
  const searchText = [
    a.title,
    a.subtitle ?? "",
    a.teaser ?? "",
    ...a.blocks.map((b) => b.text),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 100000);
  const articleId = await ctx.db.insert("articles", {
    issueId,
    order: a.order,
    title: a.title.slice(0, 300),
    subtitle: a.subtitle,
    author: a.author,
    teaser: a.teaser,
    source: a.source,
    reviewStatus,
    confidence: a.confidence,
    primaryPageIndex: a.primaryPageIndex,
    pageStart: a.pageStart,
    pageEnd: a.pageEnd,
    searchText,
    createdAt: now,
    updatedAt: now,
  });
  for (const b of a.blocks) {
    await ctx.db.insert("articleBlocks", {
      articleId,
      issueId,
      order: b.order,
      type: b.type,
      text: b.text,
      sourcePageIndex: b.sourcePageIndex,
      sourceY: b.sourceY,
      sourceStoryId: b.sourceStoryId,
      sourceFrameId: b.sourceFrameId,
      styleName: b.styleName,
      confidence: b.confidence,
      table: b.table,
    });
  }
  for (const [i, r] of a.regions.entries()) {
    await ctx.db.insert("articleRegions", {
      articleId,
      issueId,
      pageIndex: r.pageIndex,
      x0: r.x0,
      y0: r.y0,
      x1: r.x1,
      y1: r.y1,
      kind: r.kind ?? "body",
      targetPageIndex: r.targetPageIndex,
      order: i,
    });
  }
  for (const [i, img] of (a.images ?? []).entries()) {
    await ctx.db.insert("articleAssets", {
      articleId,
      issueId,
      assetId: img.assetId,
      order: i,
      caption: img.caption,
      sourcePageIndex: img.sourcePageIndex,
      sourceY: img.sourceY,
      afterBlockOrder: img.afterBlockOrder,
    });
  }
  return articleId;
}

export const activateResultInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    workerId: v.string(),
    issueId: v.id("issues"),
    articles: v.array(articleInput),
    tocEntries: v.optional(
      v.array(
        v.object({
          order: v.number(),
          label: v.string(),
          section: v.optional(v.string()),
          pageIndex: v.optional(v.number()),
          articleOrder: v.optional(v.number()),
          level: v.optional(v.number()),
        }),
      ),
    ),
    // Abo-Aufrufe und andere Flaechen, die nach draussen fuehren (pageLinks.ts).
    pageLinks: v.optional(v.array(pageLinkInput)),
  },
  handler: async (ctx, { jobId, workerId, issueId, articles, tocEntries, pageLinks }) => {
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Auftrag unbekannt");
    if (job.issueId !== issueId) throw new Error("Auftrag passt nicht zur Ausgabe");
    if (job.workerId && job.workerId !== workerId) {
      throw new Error("Sperre liegt bei einem anderen Worker");
    }

    const oldArticles = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const a of oldArticles) {
      for (const table of ["articleBlocks", "articleRegions", "articleAssets"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_article", (q: any) => q.eq("articleId", a._id))
          .collect();
        for (const r of rows) await ctx.db.delete(r._id);
      }
      await ctx.db.delete(a._id);
    }
    // Die Verknuepfungen zum Laden haengen an den alten Absaetzen; der
    // Abgleich unten legt sie fuer die neuen wieder an.
    await deleteLinksForIssue(ctx, issueId);
    const oldToc = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const t of oldToc) await ctx.db.delete(t._id);

    const now = Date.now();
    const byOrder = new Map<number, Id<"articles">>();
    for (const a of articles) {
      byOrder.set(a.order, await insertArticle(ctx, issueId, a, "pending", now));
    }

    const toc =
      tocEntries && tocEntries.length > 0
        ? tocEntries
        : articles.map((a) => ({
            order: a.order,
            label: a.title,
            pageIndex: a.primaryPageIndex,
            articleOrder: a.order,
            level: 1,
            section: undefined as string | undefined,
          }));
    for (const t of toc) {
      await ctx.db.insert("tocEntries", {
        issueId,
        order: t.order,
        label: t.label.slice(0, 300),
        section: t.section,
        pageIndex: t.pageIndex,
        articleId:
          t.articleOrder !== undefined ? byOrder.get(t.articleOrder) : undefined,
        level: t.level ?? 1,
      });
    }

    const links = await replaceImportedLinks(ctx, issueId, pageLinks ?? []);
    if ((pageLinks ?? []).some((l) => l.kind === "shop")) {
      // Produkt oder Suchseite zu den Anzeigen im Laden nachschlagen.
      await ctx.scheduler.runAfter(0, internal.pageLinks.resolveInternal, { issueId });
    }

    await ctx.db.patch(issueId, { articleCount: articles.length, updatedAt: now });
    // Buchanzeigen erkennen und mit dem Laden verbinden (articleProducts.ts).
    await ctx.scheduler.runAfter(0, internal.articleProducts.matchInternal, { issueId });
    console.log(
      JSON.stringify({
        event: "import.activated",
        issueId,
        articles: articles.length,
        toc: toc.length,
        links,
      }),
    );
    return { articles: articles.length, toc: toc.length };
  },
});

// --- Nachtrag: nur geaenderte Artikel ersetzen ----------------------------------

/**
 * Welche Stories jeder Artikel der Ausgabe traegt. Der Worker vergleicht damit
 * sein Ergebnis aus dem Satz mit dem Bestand (Auftrag "nachtrag").
 */
export const liveArticlesInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const articles = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    const out = [];
    for (const a of articles) {
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article", (q) => q.eq("articleId", a._id))
        .collect();
      const stories = [
        ...new Set(blocks.map((b) => b.sourceStoryId).filter((s): s is string => !!s)),
      ];
      out.push({
        articleId: a._id,
        order: a.order,
        title: a.title,
        pageStart: a.pageStart,
        reviewStatus: a.reviewStatus,
        stories,
      });
    }
    return out;
  },
});

async function deleteArticle(ctx: MutationCtx, articleId: Id<"articles">) {
  const blocks = await ctx.db
    .query("articleBlocks")
    .withIndex("by_article", (q) => q.eq("articleId", articleId))
    .collect();
  for (const b of blocks) {
    await deleteLinksForBlock(ctx, b._id);
    await ctx.db.delete(b._id);
  }
  for (const table of ["articleRegions", "articleAssets"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_article", (q: any) => q.eq("articleId", articleId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  }
  await ctx.db.delete(articleId);
}

/**
 * Ergebnis eines Nachtrags uebernehmen: `remove` faellt weg, `insert` kommt
 * dazu, danach werden alle Artikel der Ausgabe nach Seite und Satzfolge neu
 * gezaehlt. Neue Artikel uebernehmen die Freigabe, wenn die Ausgabe ganz
 * freigegeben ist. Verzeichniseintraege und Lesestaende auf einen ersetzten
 * Artikel zeigen danach auf seinen Nachfolger auf derselben Seite.
 */
export const mergeResultInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    workerId: v.string(),
    issueId: v.id("issues"),
    probe: v.boolean(),
    remove: v.array(v.id("articles")),
    insert: v.array(articleInput),
    // Stelle im Satz fuer die bleibenden Artikel.
    orders: v.array(v.object({ articleId: v.id("articles"), order: v.number() })),
  },
  handler: async (ctx, { jobId, workerId, issueId, probe, remove, insert, orders }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.issueId !== issueId) throw new Error("Auftrag passt nicht zur Ausgabe");
    if (job.workerId && job.workerId !== workerId) {
      throw new Error("Sperre liegt bei einem anderen Worker");
    }
    const articles = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const weg = new Set(remove.map(String));
    const removed = articles.filter((a) => weg.has(a._id));
    const summary = {
      removed: removed.map((a) => `${a.pageStart}: ${a.title.slice(0, 60)}`),
      inserted: insert.map((a) => `${a.pageStart}: ${a.title.slice(0, 60)}`),
    };
    if (probe) return summary;

    const allApproved = articles.length > 0 && articles.every((a) => a.reviewStatus === "approved");
    const now = Date.now();
    for (const a of removed) await deleteArticle(ctx, a._id);
    const neu: { id: Id<"articles">; pageStart: number; rank: number }[] = [];
    for (const a of insert) {
      const id = await insertArticle(ctx, issueId, a, allApproved ? "approved" : "pending", now);
      neu.push({ id, pageStart: a.pageStart, rank: a.order });
    }

    // Verweise auf ersetzte Artikel umhaengen.
    const nachfolger = (pageStart: number) =>
      neu.filter((n) => n.pageStart === pageStart).sort((x, y) => x.rank - y.rank)[0]?.id;
    const toc = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const t of toc) {
      if (!t.articleId || !weg.has(t.articleId)) continue;
      const alt = removed.find((a) => a._id === t.articleId)!;
      await ctx.db.patch(t._id, { articleId: nachfolger(alt.pageStart) });
    }
    const progress = await ctx.db.query("readingProgress").collect();
    for (const p of progress) {
      if (p.issueId !== issueId || !p.articleId || !weg.has(p.articleId)) continue;
      const alt = removed.find((a) => a._id === p.articleId)!;
      await ctx.db.patch(p._id, { articleId: nachfolger(alt.pageStart) });
    }

    // Neu zaehlen: Seite, dann Stelle im Satz; Artikel ohne Satz (Umschlag)
    // behalten ihre Stelle untereinander.
    const rang = new Map(orders.map((o) => [o.articleId as string, o.order]));
    const alle = [
      ...articles
        .filter((a) => !weg.has(a._id))
        .map((a) => ({ id: a._id, pageStart: a.pageStart, rank: rang.get(a._id) ?? a.order })),
      ...neu,
    ].sort((x, y) => x.pageStart - y.pageStart || x.rank - y.rank);
    for (const [i, a] of alle.entries()) {
      const doc = await ctx.db.get(a.id);
      if (doc && doc.order !== i + 1) await ctx.db.patch(a.id, { order: i + 1 });
    }
    await ctx.db.patch(issueId, { articleCount: alle.length, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.articleProducts.matchInternal, { issueId });
    console.log(
      JSON.stringify({
        event: "import.merged",
        issueId,
        removed: removed.length,
        inserted: insert.length,
      }),
    );
    return summary;
  },
});
