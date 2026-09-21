import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  MutationCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, requirePublisher, audit } from "./roles";
import { accessibleIssueIds, hasIssueAccess } from "./access";
import { assetUrl } from "./assets";
import { slugify } from "./publications";
import { syncSubscription } from "./subscriptions";
import { subscriptionIsActive } from "./access";
import { Id } from "./_generated/dataModel";

/**
 * Anzeige-Bezeichnung eines Hefts: Name, Heftbezeichnung und
 * Unter-Ueberschrift aus dem Verlagsshop, sonst eigener Titel, Titel der
 * Publikation und Heftnummer.
 */
export function shopLabels(
  issue: {
    title: string;
    issueNumber?: string;
    shopTitle?: string;
    shopDesignation?: string;
    shopSubtitle?: string;
  },
  publicationName: string | null,
) {
  const displayTitle = issue.shopTitle ?? issue.title;
  return {
    displayTitle,
    designation:
      issue.shopDesignation ??
      ([publicationName, issue.issueNumber].filter(Boolean).join(" · ") || null),
    subtitle: issue.shopSubtitle ?? null,
    // Zeile unter dem Heftnamen auf den Karten, wie bei der aktuellen
    // Ausgabe der Abo-Karte: Unter-Ueberschrift, sonst Heftbezeichnung,
    // sonst die eigene Nummer.
    edition:
      issue.shopSubtitle ??
      (issue.shopDesignation && issue.shopDesignation !== displayTitle
        ? issue.shopDesignation
        : null) ??
      (issue.issueNumber ? `Nr. ${issue.issueNumber}` : null),
  };
}

/** Kiosk: alle veroeffentlichten Ausgaben. */
export const listPublished = query({
  args: { publicationId: v.optional(v.id("publications")) },
  handler: async (ctx, { publicationId }) => {
    const rows = await ctx.db
      .query("issues")
      .withIndex("by_published", (q) => q.eq("isPublished", true))
      .collect();
    const filtered = publicationId
      ? rows.filter((i) => i.publicationId === publicationId)
      : rows;
    filtered.sort(
      (a, b) => (b.publicationDate ?? b.createdAt) - (a.publicationDate ?? a.createdAt),
    );
    return Promise.all(
      filtered.map(async (i) => {
        const publication = await ctx.db.get(i.publicationId);
        return {
          _id: i._id,
          title: i.title,
          slug: i.slug,
          issueNumber: i.issueNumber ?? null,
          description: i.description ?? null,
          pageCount: i.pageCount,
          priceAmountCents: i.priceAmountCents,
          publicationDate: i.publicationDate ?? null,
          publicationName: publication?.name ?? null,
          publicationSlug: publication?.slug ?? null,
          coverUrl: await assetUrl(ctx, i.coverAssetId),
          ...shopLabels(i, publication?.name ?? null),
        };
      }),
    );
  },
});

export const getPublic = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue) return null;
    const userId = await getAuthUserId(ctx);
    const owned = userId
      ? await hasIssueAccess(ctx, userId as Id<"users">, issueId)
      : false;
    if (!issue.isPublished && !owned) return null;
    const publication = await ctx.db.get(issue.publicationId);
    return {
      _id: issue._id,
      title: issue.title,
      publicationName: publication?.name ?? null,
      ...shopLabels(issue, publication?.name ?? null),
      slug: issue.slug,
      issueNumber: issue.issueNumber ?? null,
      description: issue.description ?? null,
      pageCount: issue.pageCount,
      priceAmountCents: issue.priceAmountCents,
      publicationDate: issue.publicationDate ?? null,
      articleCount: issue.articleCount ?? 0,
      coverUrl: await assetUrl(ctx, issue.coverAssetId),
      owned,
    };
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    return issue?._id ?? null;
  },
});

export const hasAccess = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    return await hasIssueAccess(ctx, userId as Id<"users">, issueId);
  },
});

/** Bibliothek: nur Ausgaben mit Zugriff, mit Lesefortschritt. */
export const myLibrary = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const ids = await accessibleIssueIds(ctx, userId as Id<"users">);
    const out = [];
    for (const id of ids) {
      const issue = await ctx.db.get(id as Id<"issues">);
      if (!issue) continue;
      const progress = await ctx.db
        .query("readingProgress")
        .withIndex("by_user_issue", (q) =>
          q.eq("userId", userId as Id<"users">).eq("issueId", issue._id),
        )
        .unique();
      const publication = await ctx.db.get(issue.publicationId);
      out.push({
        _id: issue._id,
        title: issue.title,
        ...shopLabels(issue, publication?.name ?? null),
        issueNumber: issue.issueNumber ?? null,
        pageCount: issue.pageCount,
        articleCount: issue.articleCount ?? 0,
        publicationName: publication?.name ?? null,
        coverUrl: await assetUrl(ctx, issue.coverAssetId),
        progress: progress
          ? {
              mode: progress.mode,
              pageIndex: progress.pageIndex,
              articleId: progress.articleId ?? null,
              updatedAt: progress.updatedAt,
            }
          : null,
      });
    }
    out.sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0));
    return out;
  },
});

// --- Redaktion ---

export const listForEditors = query({
  args: {},
  handler: async (ctx) => {
    await requireEditor(ctx);
    const rows = await ctx.db.query("issues").order("desc").collect();
    return Promise.all(
      rows.map(async (i) => {
        const pages = await ctx.db
          .query("issuePages")
          .withIndex("by_issue", (q) => q.eq("issueId", i._id))
          .collect();
        const articles = await ctx.db
          .query("articles")
          .withIndex("by_issue", (q) => q.eq("issueId", i._id))
          .collect();
        const job = await ctx.db
          .query("importJobs")
          .withIndex("by_issue", (q) => q.eq("issueId", i._id))
          .order("desc")
          .first();
        const sources = await ctx.db
          .query("issueSources")
          .withIndex("by_issue", (q) => q.eq("issueId", i._id))
          .collect();
        return {
          _id: i._id,
          publicationId: i.publicationId,
          title: i.title,
          issueNumber: i.issueNumber ?? null,
          slug: i.slug,
          priceAmountCents: i.priceAmountCents,
          isPublished: i.isPublished,
          includedInSubscription: i.includedInSubscription,
          stripePriceId: i.stripePriceId ?? null,
          externalSku: i.externalSku ?? null,
          pageCount: pages.length || i.pageCount,
          articleCount: articles.length,
          approvedArticles: articles.filter((a) => a.reviewStatus === "approved").length,
          pendingArticles: articles.filter((a) => a.reviewStatus === "pending").length,
          coverUrl: await assetUrl(ctx, i.coverAssetId),
          sources: sources.map((s) => ({
            _id: s._id,
            kind: s.kind,
            role: s.role,
            filename: s.filename,
            pageCount: s.pageCount ?? null,
          })),
          lastJob: job
            ? {
                _id: job._id,
                kind: job.kind,
                status: job.status,
                message: job.message ?? null,
                progress: job.progress ?? null,
                attempts: job.attempts,
              }
            : null,
          createdAt: i.createdAt,
        };
      }),
    );
  },
});

export const create = mutation({
  args: {
    publicationId: v.id("publications"),
    title: v.string(),
    issueNumber: v.optional(v.string()),
    publicationDate: v.optional(v.number()),
    description: v.optional(v.string()),
    priceAmountCents: v.number(),
    externalSku: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx);
    const base = slugify(
      `${args.title}${args.issueNumber ? "-" + args.issueNumber : ""}`,
    );
    let slug = base;
    let n = 2;
    while (
      await ctx.db
        .query("issues")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first()
    ) {
      slug = `${base}-${n++}`;
    }
    const now = Date.now();
    const id = await ctx.db.insert("issues", {
      publicationId: args.publicationId,
      title: args.title,
      slug,
      issueNumber: args.issueNumber,
      publicationDate: args.publicationDate,
      description: args.description,
      pageCount: 0,
      priceAmountCents: args.priceAmountCents,
      externalSku: args.externalSku,
      isPublished: false,
      includedInSubscription: true,
      createdAt: now,
      updatedAt: now,
    });
    await audit(ctx, "issue.create", id, args.title);
    return id;
  },
});

export const update = mutation({
  args: {
    issueId: v.id("issues"),
    title: v.optional(v.string()),
    issueNumber: v.optional(v.string()),
    description: v.optional(v.string()),
    publicationDate: v.optional(v.number()),
    priceAmountCents: v.optional(v.number()),
    includedInSubscription: v.optional(v.boolean()),
    externalSku: v.optional(v.string()),
  },
  handler: async (ctx, { issueId, ...patch }) => {
    await requireEditor(ctx);
    const issue = await ctx.db.get(issueId);
    if (!issue) throw new Error("Ausgabe nicht gefunden");
    const clean: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    // Preisaenderung macht den hinterlegten Stripe-Preis ungueltig.
    if (
      patch.priceAmountCents !== undefined &&
      patch.priceAmountCents !== issue.priceAmountCents
    ) {
      clean.stripePriceId = undefined;
    }
    await ctx.db.patch(issueId, clean);
  },
});

/**
 * Ausgabe veroeffentlichen: Seiten muessen aufbereitet und alle Artikel
 * entschieden sein, danach bekommen laufende Abos der Publikation das Heft.
 * Gemeinsamer Weg fuer die Redaktion und das Anlegen von der Kommandozeile.
 */
export async function publishIssue(ctx: MutationCtx, issueId: Id<"issues">) {
  const issue = await ctx.db.get(issueId);
  if (!issue) throw new Error("Ausgabe nicht gefunden");
  const pages = await ctx.db
    .query("issuePages")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  if (pages.length === 0) {
    throw new Error("Ohne aufbereitete Seiten kann nicht veröffentlicht werden");
  }
  // Gate: jeder Artikel muss entschieden sein, sonst steht im Heft
  // ungeprueftes Material.
  const articles = await ctx.db
    .query("articles")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const pending = articles.filter((a) => a.reviewStatus === "pending").length;
  if (pending > 0) {
    throw new Error(
      `Noch ${pending} Artikel ohne Entscheidung. Erst freigeben oder ausschließen.`,
    );
  }
  await ctx.db.patch(issueId, {
    isPublished: true,
    publishedAt: issue.publishedAt ?? Date.now(),
    updatedAt: Date.now(),
  });
  await audit(ctx, "issue.publish", issueId);

  // Neue Ausgabe: laufende Abos der Publikation bekommen sie dauerhaft.
  const subs = await ctx.db.query("subscriptions").collect();
  for (const sub of subs) {
    if (sub.publicationId !== issue.publicationId) continue;
    if (!subscriptionIsActive(sub)) continue;
    await syncSubscription(ctx, sub._id);
  }
}

export const setPublished = mutation({
  args: { issueId: v.id("issues"), isPublished: v.boolean() },
  handler: async (ctx, { issueId, isPublished }) => {
    await requirePublisher(ctx);
    if (isPublished) {
      await publishIssue(ctx, issueId);
      return;
    }
    const issue = await ctx.db.get(issueId);
    if (!issue) throw new Error("Ausgabe nicht gefunden");
    await ctx.db.patch(issueId, { isPublished: false, updatedAt: Date.now() });
    await audit(ctx, "issue.unpublish", issueId);
  },
});

export const remove = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requirePublisher(ctx);
    const tables = [
      "issuePages",
      "issueSources",
      "articles",
      "articleBlocks",
      "articleRegions",
      "articleAssets",
      "tocEntries",
      "importJobs",
    ] as const;
    for (const table of tables) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    const ents = await ctx.db
      .query("entitlements")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const e of ents) await ctx.db.delete(e._id);
    const sessions = await ctx.db.query("readerSessions").collect();
    for (const s of sessions) {
      if (s.issueId === issueId) await ctx.db.delete(s._id);
    }
    const progress = await ctx.db.query("readingProgress").collect();
    for (const p of progress) {
      if (p.issueId === issueId) await ctx.db.delete(p._id);
    }
    await ctx.db.delete(issueId);
    await audit(ctx, "issue.delete", issueId);
  },
});

// --- intern ---

export const getInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => await ctx.db.get(issueId),
});

export const findBySkuInternal = internalQuery({
  args: { sku: v.string() },
  handler: async (ctx, { sku }) =>
    await ctx.db
      .query("issues")
      .withIndex("by_external_sku", (q) => q.eq("externalSku", sku))
      .first(),
});

export const setStripeIdsInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    stripeProductId: v.string(),
    stripePriceId: v.string(),
  },
  handler: async (ctx, { issueId, stripeProductId, stripePriceId }) => {
    await ctx.db.patch(issueId, {
      stripeProductId,
      stripePriceId,
      updatedAt: Date.now(),
    });
  },
});

export const setCountsInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    pageCount: v.optional(v.number()),
    articleCount: v.optional(v.number()),
    coverAssetId: v.optional(v.id("assets")),
  },
  handler: async (ctx, { issueId, ...patch }) => {
    const clean: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    await ctx.db.patch(issueId, clean);
  },
});
