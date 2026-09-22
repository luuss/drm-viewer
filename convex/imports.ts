import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, audit } from "./roles";
import { articleInput } from "./articles";
import { Id } from "./_generated/dataModel";

/** Wie lange ein Worker einen Auftrag fuer sich behalten darf. */
const LEASE_MS = Number(process.env.IMPORT_LEASE_MS ?? String(10 * 60 * 1000));
const MAX_ATTEMPTS = Number(process.env.IMPORT_MAX_ATTEMPTS ?? "3");

export const jobKind = v.union(
  v.literal("prepare"),
  v.literal("pdf"),
  v.literal("idml"),
  v.literal("full"),
);

/**
 * Auftrag einstellen. Die Verarbeitung laeuft in einem eigenen Worker; die
 * Warteschlange liegt in der Datenbank, damit ein Neustart nichts verliert.
 */
export const enqueue = mutation({
  args: { issueId: v.id("issues"), kind: jobKind, payload: v.optional(v.string()) },
  handler: async (ctx, { issueId, kind, payload }) => {
    await requireEditor(ctx);
    const userId = await getAuthUserId(ctx);
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
    const id = await ctx.db.insert("importJobs", {
      issueId,
      kind,
      status: "queued",
      payload,
      attempts: 0,
      createdByUserId: (userId as Id<"users">) ?? undefined,
      createdAt: Date.now(),
    });
    await audit(ctx, "import.enqueue", issueId, kind);
    return id;
  },
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
 * Uebernimmt das Ergebnis eines Laufs in einem Zug.
 *
 * Alles aus den Quellen Abgeleitete wird ersetzt: Artikel, Bloecke, Regionen,
 * Artikelbilder und das automatisch erzeugte Inhaltsverzeichnis. Da eine
 * Convex-Mutation eine Transaktion ist, sehen Leser entweder den alten oder den
 * neuen Stand — nie eine Mischung. Quellen, Stammdaten, Kaeufe und
 * Freischaltungen bleiben unberuehrt.
 */
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
  },
  handler: async (ctx, { jobId, workerId, issueId, articles, tocEntries }) => {
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
    const oldToc = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const t of oldToc) await ctx.db.delete(t._id);

    const now = Date.now();
    const byOrder = new Map<number, Id<"articles">>();
    for (const a of articles) {
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
        reviewStatus: "pending",
        confidence: a.confidence,
        primaryPageIndex: a.primaryPageIndex,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
        searchText,
        createdAt: now,
        updatedAt: now,
      });
      byOrder.set(a.order, articleId);
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

    await ctx.db.patch(issueId, { articleCount: articles.length, updatedAt: now });
    console.log(
      JSON.stringify({
        event: "import.activated",
        issueId,
        articles: articles.length,
        toc: toc.length,
      }),
    );
    return { articles: articles.length, toc: toc.length };
  },
});
