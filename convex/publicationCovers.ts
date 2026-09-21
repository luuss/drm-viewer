import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { SHOP_URL, coverCandidates, parseMagazineStrip } from "./shopCovers";

const USER_AGENT = "LesenUndSchenkenDigital/1.0 (+https://d.chuk.dev)";

export const listInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("publications").collect();
    return rows
      .filter((p) => p.isActive)
      .map((p) => ({
        _id: p._id,
        slug: p.slug,
        coverSource: p.coverSource ?? null,
        coverAssetId: p.coverAssetId ?? null,
      }));
  },
});

/** Neues Titelbild eintragen; das vorige verschwindet samt Datei. */
export const setCoverInternal = internalMutation({
  args: {
    publicationId: v.id("publications"),
    storageId: v.id("_storage"),
    contentType: v.string(),
    bytes: v.number(),
    source: v.string(),
    label: v.string(),
    imageId: v.string(),
  },
  handler: async (ctx, args) => {
    const publication = await ctx.db.get(args.publicationId);
    if (!publication) throw new Error("Titel nicht gefunden");
    const now = Date.now();
    const assetId = await ctx.db.insert("assets", {
      key: `publications/${args.publicationId}/cover-${args.imageId}.jpg`,
      contentType: args.contentType,
      bytes: args.bytes,
      kind: "cover",
      convexStorageId: args.storageId,
      createdAt: now,
    });
    await ctx.db.patch(args.publicationId, {
      coverAssetId: assetId,
      coverSource: args.source,
      coverLabel: args.label,
      coverUpdatedAt: now,
    });
    if (publication.coverAssetId) {
      const old = await ctx.db.get(publication.coverAssetId);
      if (old) {
        if (old.convexStorageId) await ctx.storage.delete(old.convexStorageId);
        await ctx.db.delete(old._id);
      }
    }
    return assetId;
  },
});

/**
 * Titelbilder aller Reihen mit dem Verlagsshop abgleichen. Laeuft taeglich
 * (crons.ts) und von der Kommandozeile:
 *
 *     npx convex run publicationCovers:refreshAll
 *
 * Geholt wird nur, was sich geaendert hat: Adresse und Kennzeichen des Bilds
 * (ETag oder Aenderungsdatum) stehen an der Publikation.
 */
export const refreshAll = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ updated: string[]; unchanged: string[]; missing: string[]; failed: string[] }> => {
    const page = await fetch(`${SHOP_URL}/`, { headers: { "user-agent": USER_AGENT } });
    if (!page.ok) throw new Error(`Startseite des Shops: HTTP ${page.status}`);
    const entries = parseMagazineStrip(await page.text());
    const publications: {
      _id: Id<"publications">;
      slug: string;
      coverSource: string | null;
      coverAssetId: Id<"assets"> | null;
    }[] = await ctx.runQuery(internal.publicationCovers.listInternal, {});

    const result = { updated: [] as string[], unchanged: [] as string[], missing: [] as string[], failed: [] as string[] };
    for (const publication of publications) {
      const entry = entries.find((e) => e.slug === publication.slug);
      if (!entry) {
        result.missing.push(publication.slug);
        continue;
      }
      try {
        let done = false;
        for (const url of coverCandidates(entry)) {
          const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
          if (!head.ok || !(head.headers.get("content-type") ?? "").startsWith("image/")) continue;
          const mark = head.headers.get("etag") ?? head.headers.get("last-modified") ?? head.headers.get("content-length") ?? "";
          const source = `${url}|${mark}`;
          if (publication.coverAssetId && publication.coverSource === source) {
            result.unchanged.push(publication.slug);
            done = true;
            break;
          }
          const image = await fetch(url, { headers: { "user-agent": USER_AGENT } });
          if (!image.ok) continue;
          const blob = await image.blob();
          if (blob.size < 10_000) continue;
          const storageId = await ctx.storage.store(blob);
          await ctx.runMutation(internal.publicationCovers.setCoverInternal, {
            publicationId: publication._id,
            storageId,
            contentType: blob.type || "image/jpeg",
            bytes: blob.size,
            source,
            label: entry.label,
            imageId: entry.imageId,
          });
          result.updated.push(`${publication.slug}: ${entry.label} (${url})`);
          done = true;
          break;
        }
        if (!done) result.failed.push(publication.slug);
      } catch (error) {
        console.error(`Titelbild ${publication.slug}`, error);
        result.failed.push(publication.slug);
      }
    }
    console.log(JSON.stringify({ event: "covers.refresh", ...result }));
    return result;
  },
});
