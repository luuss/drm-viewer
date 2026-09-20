import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * Hilfen fuer Entwicklung und Integrationspruefung.
 *
 * Diese Funktionen sind intern und nur ueber die Kommandozeile erreichbar. Sie
 * bauen einen Testbestand auf, ohne den Weg ueber die Oberflaeche zu gehen —
 * damit laesst sich die Pipeline mit echten Heften pruefen.
 */
export const seedIssueFromAssets = internalMutation({
  args: {
    publicationName: v.string(),
    title: v.string(),
    issueNumber: v.optional(v.string()),
    priceAmountCents: v.number(),
    innerStorageId: v.id("_storage"),
    innerFilename: v.string(),
    innerPageCount: v.number(),
    coverStorageId: v.optional(v.id("_storage")),
    coverFilename: v.optional(v.string()),
    coverPageCount: v.optional(v.number()),
    printedStart: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const slug = args.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    let publication = await ctx.db
      .query("publications")
      .withIndex("by_slug", (q) => q.eq("slug", "zuerst"))
      .first();
    if (!publication) {
      const id = await ctx.db.insert("publications", {
        name: args.publicationName,
        slug: "zuerst",
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
        pageCount: args.coverPageCount ?? 4,
        sortOrder: 1,
        createdAt: now,
      });
    }

    // Vorschlag wie im Importdialog: Umschlag in Bogenreihenfolge.
    const pages: {
      sourceAssetId: Id<"assets">;
      sourcePageIndex: number;
      role: "front_cover" | "inside_front" | "content" | "inside_back" | "back_cover";
      printedLabel?: string;
    }[] = [];
    const printedStart = args.printedStart ?? 3;
    if (coverAsset && (args.coverPageCount ?? 4) === 4) {
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
    if (coverAsset && (args.coverPageCount ?? 4) === 4) {
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
    return { issueId, jobId, pages: pages.length };
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
