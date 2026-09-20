import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireEditor, requireAdmin, audit } from "./roles";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("publications").collect();
    return rows.filter((p) => p.isActive);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    await requireEditor(ctx);
    return await ctx.db.query("publications").collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, { name, description, slug }) => {
    await requireAdmin(ctx);
    const finalSlug = slug?.trim() || slugify(name);
    const clash = await ctx.db
      .query("publications")
      .withIndex("by_slug", (q) => q.eq("slug", finalSlug))
      .first();
    if (clash) throw new Error(`Kennung ${finalSlug} ist schon vergeben`);
    const id = await ctx.db.insert("publications", {
      name,
      slug: finalSlug,
      description,
      isActive: true,
      createdAt: Date.now(),
    });
    await audit(ctx, "publication.create", id, name);
    return id;
  },
});

export const setActive = mutation({
  args: { publicationId: v.id("publications"), isActive: v.boolean() },
  handler: async (ctx, { publicationId, isActive }) => {
    await requireAdmin(ctx);
    await ctx.db.patch(publicationId, { isActive });
    await audit(ctx, "publication.setActive", publicationId, String(isActive));
  },
});

export { slugify };
