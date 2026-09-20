import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { requireAdmin } from "./admin";
import { hasBookAccess, hasActiveSubscription } from "./access";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const books = await ctx.db
      .query("books")
      .filter((q) => q.eq(q.field("isPublished"), true))
      .collect();
    return Promise.all(
      books.map(async (b) => ({
        _id: b._id,
        title: b.title,
        description: b.description,
        pageCount: b.pageCount,
        priceCents: b.priceCents,
        currency: b.currency,
        coverUrl: b.coverStorageId
          ? await ctx.storage.getUrl(b.coverStorageId)
          : null,
      })),
    );
  },
});

export const myLibrary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const ents = await ctx.db
      .query("entitlements")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const bookIds = new Set<string>();
    const entries: { bookId: Id<"books">; source: string; validUntil?: number }[] = [];
    for (const e of ents) {
      if (e.validUntil !== undefined && e.validUntil <= now) continue;
      if (bookIds.has(e.bookId as string)) continue;
      bookIds.add(e.bookId as string);
      entries.push({ bookId: e.bookId, source: e.source, validUntil: e.validUntil });
    }

    // Abo schaltet alle veroeffentlichten Hefte frei, die nicht ausgenommen sind.
    if (await hasActiveSubscription(ctx, userId)) {
      const published = await ctx.db
        .query("books")
        .withIndex("by_published", (q) => q.eq("isPublished", true))
        .collect();
      for (const b of published) {
        if (b.includedInSubscription === false) continue;
        if (bookIds.has(b._id as string)) continue;
        bookIds.add(b._id as string);
        entries.push({ bookId: b._id, source: "subscription" });
      }
    }

    const result = [];
    for (const e of entries) {
      const book = await ctx.db.get(e.bookId);
      if (!book) continue;
      const progress = await ctx.db
        .query("readingProgress")
        .withIndex("by_user_book", (q) =>
          q.eq("userId", userId).eq("bookId", e.bookId),
        )
        .unique();
      result.push({
        _id: book._id,
        title: book.title,
        pageCount: book.pageCount,
        source: e.source,
        articleCount: book.articleCount ?? 0,
        currentPage: progress?.page ?? 0,
        coverUrl: book.coverStorageId
          ? await ctx.storage.getUrl(book.coverStorageId)
          : null,
      });
    }
    return result;
  },
});

export const getBook = query({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    const book = await ctx.db.get(bookId);
    if (!book) return null;
    return {
      _id: book._id,
      title: book.title,
      description: book.description,
      pageCount: book.pageCount,
      pageWidth: book.pageWidth ?? null,
      pageHeight: book.pageHeight ?? null,
      priceCents: book.priceCents,
      currency: book.currency,
      coverUrl: book.coverStorageId
        ? await ctx.storage.getUrl(book.coverStorageId)
        : null,
    };
  },
});

export const hasEntitlement = query({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    return await hasBookAccess(ctx, userId, bookId);
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const getSignedStorageUrl = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await requireAdmin(ctx);
    return await ctx.storage.getUrl(storageId);
  },
});

/**
 * Fahrschein fuer die Aufbereitung einer neuen Ausgabe im Kacheldienst.
 *
 * Der Dienst laedt und schreibt ausschliesslich Adressen, die hier
 * unterschrieben wurden. Damit ist er keine offene Sonde ins interne Netz.
 *
 * Aufbereitung heisst: Umschlag und Innenteil zu einer Datei zusammenfuegen
 * (falls getrennt geliefert) und aus der ersten Seite das Titelbild rendern.
 */
export const issuePrepareTicket = mutation({
  args: {
    innerStorageId: v.id("_storage"),
    coverPdfStorageId: v.optional(v.id("_storage")),
    filetype: v.union(v.literal("pdf"), v.literal("epub")),
    // "print": Umschlag liegt in Bogenreihenfolge vor (U4, U1, U2, U3).
    coverOrder: v.optional(v.union(v.literal("print"), v.literal("asis"))),
  },
  handler: async (ctx, { innerStorageId, coverPdfStorageId, filetype, coverOrder }) => {
    await requireAdmin(ctx);
    const secret = process.env.TILE_SERVICE_SECRET;
    if (!secret) throw new Error("TILE_SERVICE_SECRET nicht gesetzt");

    const innerUrl = await ctx.storage.getUrl(innerStorageId);
    if (!innerUrl) throw new Error("Innenteil nicht gefunden");
    const coverUrl = coverPdfStorageId
      ? await ctx.storage.getUrl(coverPdfStorageId)
      : null;
    if (coverPdfStorageId && !coverUrl) throw new Error("Umschlag nicht gefunden");

    // Der Dienst laedt das Ergebnis direkt in den Speicher hoch; die
    // Adressen sind einmalig gueltig.
    const mergedUploadUrl = coverUrl ? await ctx.storage.generateUploadUrl() : "";
    const coverImageUploadUrl = await ctx.storage.generateUploadUrl();

    const expiresAt = Date.now() + 30 * 60 * 1000;
    const sources = coverUrl ? [coverUrl, innerUrl] : [innerUrl];
    const order = coverOrder ?? "print";
    const payload = [
      sources.join("|"),
      mergedUploadUrl,
      coverImageUploadUrl,
      filetype,
      order,
      String(expiresAt),
    ].join("~");

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    const ticket = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return {
      sources,
      mergedUploadUrl,
      coverImageUploadUrl,
      filetype,
      coverOrder: order,
      expiresAt,
      ticket,
    };
  },
});

export const createBook = mutation({
  args: {
    title: v.string(),
    filename: v.string(),
    description: v.optional(v.string()),
    pdfStorageId: v.id("_storage"),
    coverStorageId: v.optional(v.id("_storage")),
    pageCount: v.number(),
    pageWidth: v.optional(v.number()),
    pageHeight: v.optional(v.number()),
    priceCents: v.number(),
    currency: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.insert("books", {
      title: args.title,
      filename: args.filename,
      description: args.description,
      pdfStorageId: args.pdfStorageId,
      coverStorageId: args.coverStorageId,
      pageCount: args.pageCount,
      pageWidth: args.pageWidth,
      pageHeight: args.pageHeight,
      priceCents: args.priceCents,
      currency: args.currency ?? "eur",
      stripePriceId: args.stripePriceId,
      isPublished: true,
      createdAt: Date.now(),
    });
  },
});

export const adminGrantSelf = mutation({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    await requireAdmin(ctx);
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .first();
    if (existing) return;
    await ctx.db.insert("entitlements", {
      userId,
      bookId,
      source: "admin",
      createdAt: Date.now(),
    });
  },
});

export const deleteBook = mutation({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    await requireAdmin(ctx);
    const book = await ctx.db.get(bookId);
    if (!book) return;
    const ents = await ctx.db
      .query("entitlements")
      .filter((q) => q.eq(q.field("bookId"), bookId))
      .collect();
    for (const e of ents) await ctx.db.delete(e._id);
    const progs = await ctx.db
      .query("readingProgress")
      .filter((q) => q.eq(q.field("bookId"), bookId))
      .collect();
    for (const p of progs) await ctx.db.delete(p._id);
    const claims = await ctx.db
      .query("claimTokens")
      .filter((q) => q.eq(q.field("bookId"), bookId))
      .collect();
    for (const c of claims) await ctx.db.delete(c._id);
    const ts = await ctx.db
      .query("tileSessions")
      .filter((q) => q.eq(q.field("bookId"), bookId))
      .collect();
    for (const t of ts) await ctx.db.delete(t._id);
    await ctx.storage.delete(book.pdfStorageId);
    if (book.coverStorageId)
      await ctx.storage.delete(book.coverStorageId).catch(() => {});
    await ctx.db.delete(bookId);
  },
});

export const grantEntitlementInternal = internalMutation({
  args: {
    userId: v.id("users"),
    bookId: v.id("books"),
    source: v.union(
      v.literal("purchase"),
      v.literal("claim"),
      v.literal("admin"),
      v.literal("gift"),
    ),
    stripeSessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", args.userId).eq("bookId", args.bookId),
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("entitlements", {
      userId: args.userId,
      bookId: args.bookId,
      source: args.source,
      stripeSessionId: args.stripeSessionId,
      createdAt: Date.now(),
    });
  },
});

export const getStoragePdfUrlForService = internalQuery({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => {
    const book = await ctx.db.get(bookId);
    if (!book) throw new Error("Book not found");
    const url = await ctx.storage.getUrl(book.pdfStorageId);
    return { url, pageCount: book.pageCount, filename: book.filename };
  },
});

/** Upload-Adresse fuer den Extraktionsdienst (Artikelbilder). */
export const generateUploadUrlInternal = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const getBookInternal = internalQuery({
  args: { bookId: v.id("books") },
  handler: async (ctx, { bookId }) => await ctx.db.get(bookId),
});

export const setStripeIdsInternal = internalMutation({
  args: {
    bookId: v.id("books"),
    stripeProductId: v.string(),
    stripePriceId: v.string(),
  },
  handler: async (ctx, { bookId, stripeProductId, stripePriceId }) => {
    await ctx.db.patch(bookId, { stripeProductId, stripePriceId });
  },
});

export const setArticleCountInternal = internalMutation({
  args: { bookId: v.id("books"), articleCount: v.number() },
  handler: async (ctx, { bookId, articleCount }) => {
    await ctx.db.patch(bookId, { articleCount });
  },
});

/** Admin-Liste: auch unveroeffentlichte Hefte, mit Import- und Preis-Status. */
export const listAllAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const books = await ctx.db.query("books").order("desc").collect();
    return Promise.all(
      books.map(async (b) => {
        const articles = await ctx.db
          .query("articles")
          .withIndex("by_book", (q) => q.eq("bookId", b._id))
          .collect();
        const job = await ctx.db
          .query("importJobs")
          .withIndex("by_book", (q) => q.eq("bookId", b._id))
          .order("desc")
          .first();
        return {
          _id: b._id,
          title: b.title,
          issueNumber: b.issueNumber ?? null,
          description: b.description ?? null,
          pageCount: b.pageCount,
          priceCents: b.priceCents,
          currency: b.currency,
          isPublished: b.isPublished,
          includedInSubscription: b.includedInSubscription !== false,
          stripePriceId: b.stripePriceId ?? null,
          articleCount: articles.length,
          publishedArticles: articles.filter((a) => a.status === "published").length,
          coverUrl: b.coverStorageId ? await ctx.storage.getUrl(b.coverStorageId) : null,
          lastImport: job
            ? { status: job.status, message: job.message ?? null, kind: job.kind }
            : null,
          createdAt: b.createdAt,
        };
      }),
    );
  },
});

export const updateBook = mutation({
  args: {
    bookId: v.id("books"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    issueNumber: v.optional(v.string()),
    priceCents: v.optional(v.number()),
    isPublished: v.optional(v.boolean()),
    includedInSubscription: v.optional(v.boolean()),
  },
  handler: async (ctx, { bookId, ...patch }) => {
    await requireAdmin(ctx);
    const book = await ctx.db.get(bookId);
    if (!book) throw new Error("Heft nicht gefunden");
    const clean: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    if (patch.isPublished === true && !book.publishedAt) {
      clean.publishedAt = Date.now();
    }
    // Preisaenderung macht den alten Stripe-Preis ungueltig: neu anlegen lassen.
    if (patch.priceCents !== undefined && patch.priceCents !== book.priceCents) {
      clean.stripePriceId = undefined;
    }
    await ctx.db.patch(bookId, clean);
  },
});

export const setSourceStorageId = mutation({
  args: { bookId: v.id("books"), sourceStorageId: v.id("_storage") },
  handler: async (ctx, { bookId, sourceStorageId }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(bookId, { sourceStorageId });
  },
});

export const getSourceUrlForService = internalQuery({
  args: {
    bookId: v.id("books"),
    which: v.union(v.literal("pdf"), v.literal("source")),
  },
  handler: async (ctx, { bookId, which }) => {
    const book = await ctx.db.get(bookId);
    if (!book) throw new Error("Book not found");
    const storageId = which === "pdf" ? book.pdfStorageId : book.sourceStorageId;
    if (!storageId) return null;
    return {
      url: await ctx.storage.getUrl(storageId),
      pageCount: book.pageCount,
      filename: book.filename,
    };
  },
});

/** Dateien einer Ausgabe ersetzen (Wartung, z.B. neu zusammengefuegter Umschlag). */
export const setFilesInternal = internalMutation({
  args: {
    bookId: v.id("books"),
    pdfStorageId: v.optional(v.id("_storage")),
    coverStorageId: v.optional(v.id("_storage")),
    pageCount: v.optional(v.number()),
    pageWidth: v.optional(v.number()),
    pageHeight: v.optional(v.number()),
  },
  handler: async (ctx, { bookId, ...patch }) => {
    const clean: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    await ctx.db.patch(bookId, clean);
    return clean;
  },
});
