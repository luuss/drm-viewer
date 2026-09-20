import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { requireEditor } from "./roles";
import { Id } from "./_generated/dataModel";

export const assetKind = v.union(
  v.literal("source"),
  v.literal("page"),
  v.literal("tile"),
  v.literal("image"),
  v.literal("cover"),
);

/**
 * Upload aus der Redaktionsoberflaeche. Die Datei landet zunaechst in der
 * Convex-Ablage; der Import-Worker schiebt sie in den Medien-Bucket, sobald
 * einer eingerichtet ist. `assets.key` bleibt in beiden Faellen die Adresse.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireEditor(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const registerUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    key: v.string(),
    contentType: v.string(),
    kind: assetKind,
    issueId: v.optional(v.id("issues")),
    bytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx);
    return await ctx.db.insert("assets", {
      key: args.key,
      contentType: args.contentType,
      kind: args.kind,
      issueId: args.issueId,
      convexStorageId: args.storageId,
      bytes: args.bytes,
      createdAt: Date.now(),
    });
  },
});

export const createInternal = internalMutation({
  args: {
    key: v.string(),
    bucket: v.optional(v.string()),
    contentType: v.string(),
    kind: assetKind,
    issueId: v.optional(v.id("issues")),
    convexStorageId: v.optional(v.id("_storage")),
    bytes: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args });
      return existing._id;
    }
    return await ctx.db.insert("assets", { ...args, createdAt: Date.now() });
  },
});

export const getInternal = internalQuery({
  args: { assetId: v.id("assets") },
  handler: async (ctx, { assetId }) => await ctx.db.get(assetId),
});

/** Kurzlebige URL zur Datei, nur fuer Dienste — nie an den Browser. */
export const serviceUrlInternal = internalQuery({
  args: { assetId: v.id("assets") },
  handler: async (ctx, { assetId }) => {
    const asset = await ctx.db.get(assetId);
    if (!asset) return null;
    const url = asset.convexStorageId
      ? await ctx.storage.getUrl(asset.convexStorageId)
      : null;
    return {
      key: asset.key,
      bucket: asset.bucket ?? null,
      contentType: asset.contentType,
      url,
    };
  },
});

export const publicUrlInternal = internalQuery({
  args: { assetId: v.optional(v.id("assets")) },
  handler: async (ctx, { assetId }) => {
    if (!assetId) return null;
    const asset = await ctx.db.get(assetId);
    if (!asset?.convexStorageId) return null;
    return await ctx.storage.getUrl(asset.convexStorageId);
  },
});

/** Hilfsfunktion fuer Queries, die Coverbilder ausliefern. */
export async function assetUrl(
  ctx: any,
  assetId: Id<"assets"> | undefined | null,
): Promise<string | null> {
  if (!assetId) return null;
  const asset = await ctx.db.get(assetId);
  if (!asset?.convexStorageId) return null;
  return await ctx.storage.getUrl(asset.convexStorageId);
}

/** Upload-Adresse fuer den Import-Worker. */
export const generateUploadUrlInternal = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});
