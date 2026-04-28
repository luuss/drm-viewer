import { v } from "convex/values";
import { mutation, query, action, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { requireAdmin } from "./admin";

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
    const ents = await ctx.db
      .query("entitlements")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const result = [];
    for (const e of ents) {
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
    const ent = await ctx.db
      .query("entitlements")
      .withIndex("by_user_book", (q) =>
        q.eq("userId", userId).eq("bookId", bookId),
      )
      .first();
    return ent !== null;
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

export const getStoragePdfUrlForService = query({
  args: { bookId: v.id("books"), serviceSecret: v.string() },
  handler: async (ctx, { bookId, serviceSecret }) => {
    if (serviceSecret !== process.env.TILE_SERVICE_SECRET) {
      throw new Error("Invalid service secret");
    }
    const book = await ctx.db.get(bookId);
    if (!book) throw new Error("Book not found");
    const url = await ctx.storage.getUrl(book.pdfStorageId);
    return { url, pageCount: book.pageCount, filename: book.filename };
  },
});
