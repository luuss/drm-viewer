import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEditor, audit } from "./roles";

export const sourceKind = v.union(
  v.literal("pdf"),
  v.literal("idml"),
  v.literal("indd"),
  v.literal("image"),
  v.literal("artwork"),
);

export const sourceRole = v.union(
  v.literal("inner"),
  v.literal("cover"),
  v.literal("supplemental"),
  v.literal("archive"),
  v.literal("artwork"),
);

export const listForIssue = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("issueSources")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    rows.sort((a, b) => a.sortOrder - b.sortOrder);
    return rows;
  },
});

/**
 * Die platzierten Bilder eines Hefts. Sie stehen getrennt, weil es je Heft
 * siebzig und mehr sein koennen und die Quellenliste der Oberflaeche davon
 * unuebersichtlich wuerde.
 */
export const listArtwork = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    return await ctx.db
      .query("issueSources")
      .withIndex("by_issue_kind", (q) =>
        q.eq("issueId", issueId).eq("kind", "artwork"),
      )
      .collect();
  },
});

type SourceArgs = {
  issueId: any;
  assetId: any;
  kind: "pdf" | "idml" | "indd" | "image" | "artwork";
  role: "inner" | "cover" | "supplemental" | "archive" | "artwork";
  filename: string;
  pageCount?: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
};

/**
 * Eine Quelle eintragen und die Vorgaengerin desselben Platzes entfernen.
 *
 * Ein Platz ist Art plus Rolle — ein zweites Innenteil-PDF ersetzt das erste.
 * Archive und platzierte Bilder gibt es dagegen viele nebeneinander; dort
 * zaehlt zusaetzlich der Dateiname.
 */
async function addSource(ctx: any, args: SourceArgs) {
  const existing = await ctx.db
    .query("issueSources")
    .withIndex("by_issue", (q: any) => q.eq("issueId", args.issueId))
    .collect();
  const mehrfach = args.kind === "indd" || args.kind === "artwork";
  for (const e of existing) {
    const sameSlot = e.kind === args.kind && e.role === args.role;
    const replaces = mehrfach ? sameSlot && e.filename === args.filename : sameSlot;
    if (replaces) await ctx.db.delete(e._id);
  }
  return await ctx.db.insert("issueSources", {
    ...args,
    sortOrder: existing.length,
    createdAt: Date.now(),
  });
}

export const add = mutation({
  args: {
    issueId: v.id("issues"),
    assetId: v.id("assets"),
    kind: sourceKind,
    role: sourceRole,
    filename: v.string(),
    pageCount: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    sourceWidth: v.optional(v.number()),
    sourceHeight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx);
    const id = await addSource(ctx, args);
    await audit(ctx, "issue.source.add", args.issueId, `${args.role}/${args.filename}`);
    return id;
  },
});

/**
 * Mehrere platzierte Bilder auf einmal eintragen. Ein Heft bringt siebzig und
 * mehr mit; einzeln eingetragen waeren das ebenso viele Schreibvorgaenge.
 */
export const addArtwork = mutation({
  args: {
    issueId: v.id("issues"),
    items: v.array(
      v.object({
        assetId: v.id("assets"),
        filename: v.string(),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        sourceWidth: v.optional(v.number()),
        sourceHeight: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { issueId, items }) => {
    await requireEditor(ctx);
    // Die vorhandenen Quellen einmal lesen, nicht je Bild neu: bei siebzig
    // Bildern waere das Nachschlagen sonst das Teuerste an der Mutation.
    const existing = await ctx.db
      .query("issueSources")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const vorhanden = new Map(
      existing
        .filter((e) => e.kind === "artwork")
        .map((e) => [e.filename, e._id] as const),
    );
    let sortOrder = existing.length;
    const ids = [];
    for (const item of items) {
      const alt = vorhanden.get(item.filename);
      if (alt) {
        await ctx.db.delete(alt);
        vorhanden.delete(item.filename);
      }
      ids.push(
        await ctx.db.insert("issueSources", {
          issueId,
          kind: "artwork",
          role: "artwork",
          ...item,
          sortOrder: sortOrder++,
          createdAt: Date.now(),
        }),
      );
    }
    await audit(ctx, "issue.source.artwork", issueId, `${items.length} Bilder`);
    return ids;
  },
});

export const setPageCount = mutation({
  args: { sourceId: v.id("issueSources"), pageCount: v.number() },
  handler: async (ctx, { sourceId, pageCount }) => {
    await requireEditor(ctx);
    await ctx.db.patch(sourceId, { pageCount });
  },
});

export const remove = mutation({
  args: { sourceId: v.id("issueSources") },
  handler: async (ctx, { sourceId }) => {
    await requireEditor(ctx);
    await ctx.db.delete(sourceId);
  },
});
