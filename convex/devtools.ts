import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { slugify } from "./publications";

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

/** Rolle setzen, ohne den Umweg ueber die Oberflaeche. */
export const setRolesByEmail = internalMutation({
  args: { email: v.string(), roles: v.array(v.string()) },
  handler: async (ctx, { email, roles }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email.toLowerCase()))
      .first();
    if (!user) return { ok: false };
    await ctx.db.patch(user._id, { roles } as any);
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
