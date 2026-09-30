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

/**
 * Seiten an einer Stelle der Leserreihenfolge einfuegen — und alles
 * nachruecken, was Seiten zaehlt: Artikel (Anfang, Ende, Hauptseite),
 * Absaetze, Klickflaechen samt Sprungziel, Bildanker, Verzeichniseintraege
 * und Lesestaende. Gebraucht, um Umschlagseiten (U2, U3, U4) einem Heft
 * nachzuruesten, das ohne sie importiert wurde, ohne den Import zu
 * wiederholen. Nur mit Deploy-Schluessel (`npx convex run`).
 */
export const insertInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    at: v.number(),
    pages: v.array(
      v.object({
        role: pageRole,
        printedLabel: v.optional(v.string()),
        sourceAssetId: v.id("assets"),
        sourcePageIndex: v.number(),
        previewKey: v.optional(v.string()),
        width: v.number(),
        height: v.number(),
      }),
    ),
  },
  handler: async (ctx, { issueId, at, pages }) => {
    const n = pages.length;
    const existing = await ctx.db
      .query("issuePages")
      .withIndex("by_issue_index", (q) => q.eq("issueId", issueId))
      .collect();
    if (!n) return { inserted: 0, shifted: 0, pageCount: existing.length };
    if (at < 0 || at > existing.length) throw new Error("Einfuegestelle liegt ausserhalb der Seiten");
    const rueck = (wert: number) => (wert >= at ? wert + n : wert);
    let shifted = 0;

    for (const p of existing) {
      if (p.index >= at) {
        await ctx.db.patch(p._id, { index: p.index + n });
        shifted++;
      }
    }
    const articles = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const a of articles) {
      const neu = {
        primaryPageIndex: rueck(a.primaryPageIndex),
        pageStart: rueck(a.pageStart),
        pageEnd: rueck(a.pageEnd),
      };
      if (
        neu.primaryPageIndex !== a.primaryPageIndex ||
        neu.pageStart !== a.pageStart ||
        neu.pageEnd !== a.pageEnd
      ) {
        await ctx.db.patch(a._id, neu);
        shifted++;
      }
    }
    for (const table of ["articleBlocks", "articleAssets"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_issue", (q: any) => q.eq("issueId", issueId))
        .collect();
      for (const r of rows) {
        if (r.sourcePageIndex !== undefined && r.sourcePageIndex >= at) {
          await ctx.db.patch(r._id, { sourcePageIndex: r.sourcePageIndex + n });
          shifted++;
        }
      }
    }
    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const r of regions) {
      const patch: { pageIndex?: number; targetPageIndex?: number } = {};
      if (r.pageIndex >= at) patch.pageIndex = r.pageIndex + n;
      if (r.targetPageIndex !== undefined && r.targetPageIndex >= at) {
        patch.targetPageIndex = r.targetPageIndex + n;
      }
      if (Object.keys(patch).length) {
        await ctx.db.patch(r._id, patch);
        shifted++;
      }
    }
    const toc = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    for (const t of toc) {
      if (t.pageIndex !== undefined && t.pageIndex >= at) {
        await ctx.db.patch(t._id, { pageIndex: t.pageIndex + n });
        shifted++;
      }
    }
    // Lesestaende haben keinen Index je Heft; die Tabelle ist klein.
    const progress = await ctx.db
      .query("readingProgress")
      .filter((q) => q.eq(q.field("issueId"), issueId))
      .collect();
    for (const p of progress) {
      if (p.pageIndex >= at) {
        await ctx.db.patch(p._id, { pageIndex: p.pageIndex + n });
        shifted++;
      }
    }

    for (const [i, p] of pages.entries()) {
      await ctx.db.insert("issuePages", {
        issueId,
        index: at + i,
        printedLabel: p.printedLabel,
        role: p.role,
        sourceAssetId: p.sourceAssetId,
        sourcePageIndex: p.sourcePageIndex,
        width: p.width,
        height: p.height,
        previewKey: p.previewKey,
      });
    }
    const pageCount = existing.length + n;
    await ctx.db.patch(issueId, { pageCount, updatedAt: Date.now() });
    return { inserted: n, shifted, pageCount };
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
