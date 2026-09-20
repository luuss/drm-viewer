import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAdmin } from "./admin";
import { Id } from "./_generated/dataModel";

const articleValidator = v.object({
  order: v.number(),
  title: v.string(),
  subtitle: v.optional(v.string()),
  author: v.optional(v.string()),
  teaser: v.optional(v.string()),
  text: v.string(),
  pageStart: v.number(),
  pageEnd: v.number(),
  boxes: v.array(
    v.object({
      page: v.number(),
      x0: v.number(),
      y0: v.number(),
      x1: v.number(),
      y1: v.number(),
    }),
  ),
  source: v.union(v.literal("idml"), v.literal("pdf"), v.literal("manual")),
});

export const createJobInternal = internalMutation({
  args: {
    bookId: v.id("books"),
    kind: v.union(v.literal("idml"), v.literal("pdf")),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, { bookId, kind, userId }) => {
    return await ctx.db.insert("importJobs", {
      bookId,
      kind,
      status: "queued",
      createdByUserId: userId,
      startedAt: Date.now(),
    });
  },
});

export const applyResult = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    bookId: v.id("books"),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
    ),
    message: v.optional(v.string()),
    progress: v.optional(v.number()),
    replace: v.optional(v.boolean()),
    articles: v.optional(v.array(articleValidator)),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job unbekannt");
    if (job.bookId !== args.bookId) throw new Error("Job passt nicht zur Ausgabe");

    let count = job.articleCount ?? 0;
    if (args.articles && args.articles.length > 0) {
      const old = args.replace
        ? await ctx.db
            .query("articles")
            .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
            .collect()
        : [];
      for (const o of old) await ctx.db.delete(o._id);

      for (const a of args.articles) {
        await ctx.db.insert("articles", {
          bookId: args.bookId,
          order: a.order,
          title: a.title,
          subtitle: a.subtitle,
          author: a.author,
          teaser: a.teaser,
          text: a.text,
          pageStart: a.pageStart,
          pageEnd: a.pageEnd,
          boxes: a.boxes,
          source: a.source,
          status: "draft",
          updatedAt: Date.now(),
        });
      }
      const all = await ctx.db
        .query("articles")
        .withIndex("by_book", (q) => q.eq("bookId", args.bookId))
        .collect();
      count = all.length;
      await ctx.db.patch(args.bookId, { articleCount: count });
    }

    await ctx.db.patch(args.jobId, {
      status: args.status,
      message: args.message,
      progress: args.progress,
      articleCount: count,
      finishedAt:
        args.status === "done" || args.status === "error" ? Date.now() : undefined,
    });
    return { ok: true, articleCount: count };
  },
});

export const setJobStatusInternal = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
    ),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, status, message }) => {
    await ctx.db.patch(jobId, {
      status,
      message,
      finishedAt: status === "done" || status === "error" ? Date.now() : undefined,
    });
  },
});

export const getJobInternal = internalQuery({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => await ctx.db.get(jobId),
});

/**
 * Startet die Artikel-Extraktion. IDML wird bevorzugt: dort sind die Artikel
 * als zusammenhaengende Stories bereits sauber getrennt. PDF ist der
 * Heuristik-Weg mit optionaler LLM-Gruppierung im Extraktions-Dienst.
 */
export const start = action({
  args: {
    bookId: v.id("books"),
    kind: v.union(v.literal("idml"), v.literal("pdf")),
  },
  handler: async (ctx, { bookId, kind }): Promise<{ jobId: Id<"importJobs"> }> => {
    await ctx.runQuery(api.users.requireAdminQuery, {});
    const userId = (await getAuthUserId(ctx)) ?? undefined;

    const serviceUrl = process.env.EXTRACT_SERVICE_URL;
    const secret =
      process.env.EXTRACT_SERVICE_SECRET ?? process.env.TILE_SERVICE_SECRET;
    if (!serviceUrl) throw new Error("EXTRACT_SERVICE_URL nicht gesetzt");
    if (!secret) throw new Error("EXTRACT_SERVICE_SECRET nicht gesetzt");

    const jobId: Id<"importJobs"> = await ctx.runMutation(
      internal.imports.createJobInternal,
      { bookId, kind, userId: userId as Id<"users"> | undefined },
    );

    const src: any = await ctx.runQuery(internal.books.getSourceUrlForService, {
      bookId,
      which: kind === "idml" ? "source" : "pdf",
    });
    if (!src?.url) {
      await ctx.runMutation(internal.imports.setJobStatusInternal, {
        jobId,
        status: "error",
        message:
          kind === "idml"
            ? "Keine IDML-Quelldatei hinterlegt"
            : "Keine PDF-Datei hinterlegt",
      });
      throw new Error("Quelldatei fehlt");
    }

    const convexSiteUrl = process.env.CONVEX_SITE_URL;
    const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/api/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-secret": secret,
      },
      body: JSON.stringify({
        jobId,
        bookId,
        kind,
        url: src.url,
        callbackUrl: `${convexSiteUrl}/import/result`,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      await ctx.runMutation(internal.imports.setJobStatusInternal, {
        jobId,
        status: "error",
        message: `Dienst antwortet ${res.status}: ${text.slice(0, 300)}`,
      });
      throw new Error(`Extraktionsdienst nicht erreichbar (${res.status})`);
    }

    await ctx.runMutation(internal.imports.setJobStatusInternal, {
      jobId,
      status: "running",
      message: "Extraktion laeuft",
    });
    return { jobId };
  },
});

export const listForBook = query({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("importJobs")
      .withIndex("by_book", (q) => q.eq("bookId", bookId))
      .order("desc")
      .take(10);
  },
});

export const cancelJob = mutation({
  args: { jobId: v.id("importJobs") },
  handler: async (ctx, { jobId }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(jobId, {
      status: "error",
      message: "Abgebrochen",
      finishedAt: Date.now(),
    });
  },
});
