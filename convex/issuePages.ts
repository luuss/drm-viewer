import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor } from "./roles";
import { hasIssueAccess } from "./access";
import { pageHalf, pageRole } from "./schema";
import { assetUrl } from "./assets";
import { Id } from "./_generated/dataModel";

/** Kanonische Seitenliste fuer den Reader. Ohne Zugriff kommt nichts zurueck. */
export const listForReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const pages = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId))
      .collect();
    return pages.map((p) => ({
      index: p.index,
      printedLabel: p.printedLabel ?? null,
      role: p.role,
      width: p.width,
      height: p.height,
    }));
  },
});

export const listForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    return await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId))
      .collect();
  },
});

/**
 * Diagnoseansicht fuer die Redaktion. Anders als der Reader liefert sie die
 * gerenderten Seiten direkt aus der Ablage und behaelt Quellindex, Rohmasse
 * und Renderstatus bei. So kann ein fehlerhafter Import untersucht werden,
 * ohne der angemeldeten Person erst eine Leserfreigabe zu geben.
 */
export const debugForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const pages = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId))
      .collect();

    const out = [];
    for (const page of pages) {
      const preview = page.previewKey
        ? await ctx.db
            .query("assets")
            .withIndex("by_key", (q) => q.eq("key", page.previewKey!))
            .first()
        : null;
      const previewUrl = preview ? await assetUrl(ctx, preview._id) : null;
      out.push({
        _id: page._id,
        index: page.index,
        printedLabel: page.printedLabel ?? null,
        role: page.role,
        sourceAssetId: page.sourceAssetId,
        sourcePageIndex: page.sourcePageIndex,
        sourceHalf: page.sourceHalf ?? null,
        width: preview?.width ?? page.width,
        height: preview?.height ?? page.height,
        previewKey: page.previewKey ?? null,
        previewUrl,
      });
    }
    return out;
  },
});

/**
 * Setzt die Leserreihenfolge. Die Redaktion bestaetigt oder korrigiert den
 * Vorschlag aus dem Wizard; hartcodierte Annahmen gibt es keine.
 */
export const setOrder = mutation({
  args: {
    issueId: v.id("issues"),
    pages: v.array(
      v.object({
        sourceAssetId: v.id("assets"),
        sourcePageIndex: v.number(),
        // Nur bei Doppelseiten gesetzt: welche Haelfte die Leserseite ist.
        sourceHalf: v.optional(pageHalf),
        role: pageRole,
        printedLabel: v.optional(v.string()),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        // Gesetzt, wenn die Seite schon als Bild vorliegt — etwa weil der
        // Browser sie beim Import gerendert hat. Dann muss der Worker sie
        // nicht mehr aus der Druckdatei herstellen.
        previewKey: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { issueId, pages }) => {
    await requireEditor(ctx);
    const old = await ctx.db
      .query("issuePages")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const o of old) await ctx.db.delete(o._id);

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
        width: p.width ?? 0,
        height: p.height ?? 0,
        previewKey: p.previewKey,
      });
    }
    await ctx.db.patch(issueId, { pageCount: pages.length, updatedAt: Date.now() });
    return pages.length;
  },
});

export const listInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) =>
    await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId))
      .collect(),
});

export const setRenderedInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    index: v.number(),
    width: v.number(),
    height: v.number(),
    tileManifestKey: v.optional(v.string()),
    previewKey: v.optional(v.string()),
  },
  handler: async (ctx, { issueId, index, ...patch }) => {
    const page = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId).eq("index", index))
      .unique();
    if (!page) return null;
    await ctx.db.patch(page._id, patch);
    return page._id;
  },
});

/** Der Kacheldienst fragt hier, welche Quellseite hinter einer Leserseite liegt. */
export const resolveForServiceInternal = internalQuery({
  args: { issueId: v.id("issues"), index: v.number() },
  handler: async (ctx, { issueId, index }) => {
    const page = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId).eq("index", index))
      .unique();
    if (!page) return null;
    // Das Gateway bekommt das fertig gerenderte Seitenbild, nie die Druckdatei.
    const rendered = page.previewKey
      ? await ctx.db
          .query("assets")
          .withIndex("by_key", (q) => q.eq("key", page.previewKey!))
          .first()
      : null;
    if (!rendered) {
      return {
        ready: false as const,
        width: page.width,
        height: page.height,
      };
    }
    const url = rendered.convexStorageId
      ? await ctx.storage.getUrl(rendered.convexStorageId)
      : null;
    return {
      ready: true as const,
      width: rendered.width ?? page.width,
      height: rendered.height ?? page.height,
      key: rendered.key,
      bucket: rendered.bucket ?? null,
      url,
    };
  },
});
