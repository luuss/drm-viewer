import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { requireEditor } from "./roles";
import { assertUploadAllowed } from "./uploadRules";
import { Doc, Id } from "./_generated/dataModel";
import { isPublicTocPage } from "./tocPreview";

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

/**
 * Eintrag nach dem Upload — fuer beide Wege gleich: ueber die Convex-Ablage
 * (`storageId`) oder direkt in den Medienspeicher (`bucket`).
 */
export const registerUpload = mutation({
  args: {
    storageId: v.optional(v.id("_storage")),
    bucket: v.optional(v.string()),
    key: v.string(),
    contentType: v.string(),
    kind: assetKind,
    issueId: v.optional(v.id("issues")),
    bytes: v.optional(v.number()),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx);
    if (!args.storageId && !args.bucket) {
      throw new Error("Weder Convex-Ablage noch Eimer angegeben");
    }
    assertUploadAllowed(
      args.contentType,
      args.bytes ?? 0,
      args.filename ?? args.key,
    );
    return await ctx.db.insert("assets", {
      key: args.key,
      bucket: args.bucket,
      contentType: args.contentType,
      kind: args.kind,
      issueId: args.issueId,
      convexStorageId: args.storageId,
      bytes: args.bytes,
      createdAt: Date.now(),
    });
  },
});

/**
 * Stand einer Datei fuer Zwischenspeicher. Der Import legt Seiten und
 * Artikelbilder unter festen Schluesseln ab (`images/{seite}-{x0}-{y0}.jpg`)
 * und ueberschreibt sie beim Neuimport; der Schluessel allein sagt also
 * nicht, ob das Bild noch dasselbe ist. Zeitpunkt und Groesse sagen es.
 */
export function assetStand(asset: Doc<"assets">): string {
  return `${asset.updatedAt ?? asset._creationTime}:${asset.bytes ?? ""}`;
}

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
      await ctx.db.patch(existing._id, { ...args, updatedAt: Date.now() });
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
/**
 * Adresse eines Bildes fuer den Browser.
 *
 * Liegt die Datei in der Convex-Ablage, gibt es dafuer eine fertige Adresse.
 * Liegt sie dagegen im Medienspeicher, hat Convex keine — dort fuehrt der Weg
 * ueber das Kachel-Gateway, das den Zugang hat und die Lesesitzung prueft.
 */
export async function assetUrl(
  ctx: any,
  assetId: Id<"assets"> | undefined | null,
): Promise<string | null> {
  if (!assetId) return null;
  const asset = await ctx.db.get(assetId);
  if (!asset) return null;
  if (asset.convexStorageId) return await ctx.storage.getUrl(asset.convexStorageId);
  if (!asset.bucket) return null;
  const gateway = (process.env.PUBLIC_TILE_ORIGIN ?? "").replace(/\/$/, "");
  return gateway ? `${gateway}/api/asset/${assetId}.jpg` : null;
}

/**
 * Bildadresse fuer die Redaktion. Die Seitenvorschauen im Admin sind
 * schlichte `<img>` ohne Lesesitzung; das Gateway laesst sie nur mit dieser
 * Unterschrift durch (`?r=<ablauf>.<hmac>`, Geheimnis des Kacheldienstes).
 * Der Ablauf springt einmal am Tag, damit die Query-Ergebnisse stabil
 * bleiben; gueltig ist eine Adresse 24 bis 48 Stunden. Nur nach
 * `requireEditor` aufrufen.
 */
export async function redaktionsAssetUrl(
  ctx: any,
  assetId: Id<"assets"> | undefined | null,
): Promise<string | null> {
  const url = await assetUrl(ctx, assetId);
  const secret = process.env.TILE_SERVICE_SECRET ?? "";
  if (!url || !assetId || !secret || !url.includes("/api/asset/")) return url;
  const tag = 86_400;
  const ablauf = (Math.floor(Date.now() / 1000 / tag) + 2) * tag;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`redaktion:${assetId}:${ablauf}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${url}?r=${ablauf}.${hex}`;
}

/**
 * Was das Kachel-Gateway braucht, um ein Bild auszuliefern: wo es liegt und
 * ob es oeffentlich ist. Titelbilder und die Seiten des gedruckten
 * Inhaltsverzeichnisses stehen im Kiosk und sind frei; alles andere gehoert
 * zum bezahlten Inhalt.
 */
export const resolveForServiceInternal = internalQuery({
  args: { assetId: v.string() },
  handler: async (ctx, { assetId }) => {
    let asset;
    try {
      asset = await ctx.db.get(assetId as Id<"assets">);
    } catch {
      return null;
    }
    if (!asset) return null;
    return {
      public: asset.kind === "cover" || (await isPublicTocPage(ctx, asset)),
      issueId: asset.issueId ?? null,
      key: asset.key,
      bucket: asset.bucket ?? null,
      contentType: asset.contentType,
      url: asset.convexStorageId
        ? await ctx.storage.getUrl(asset.convexStorageId)
        : null,
      stand: assetStand(asset),
    };
  },
});

/** Upload-Adresse fuer den Import-Worker. */
export const generateUploadUrlInternal = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});
