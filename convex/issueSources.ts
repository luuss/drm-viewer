import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEditor, audit } from "./roles";

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

export const add = mutation({
  args: {
    issueId: v.id("issues"),
    assetId: v.id("assets"),
    kind: v.union(v.literal("pdf"), v.literal("idml"), v.literal("indd")),
    role: v.union(
      v.literal("inner"),
      v.literal("cover"),
      v.literal("supplemental"),
      v.literal("archive"),
    ),
    filename: v.string(),
    pageCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireEditor(ctx);
    const existing = await ctx.db
      .query("issueSources")
      .withIndex("by_issue", (q) => q.eq("issueId", args.issueId))
      .collect();
    // Dieselbe Rolle ersetzt die vorherige Datei, damit kein Wildwuchs entsteht.
    for (const e of existing) {
      if (e.kind === args.kind && e.role === args.role) await ctx.db.delete(e._id);
    }
    const id = await ctx.db.insert("issueSources", {
      ...args,
      sortOrder: existing.length,
      createdAt: Date.now(),
    });
    await audit(ctx, "issue.source.add", args.issueId, `${args.role}/${args.filename}`);
    return id;
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
