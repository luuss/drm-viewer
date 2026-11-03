/**
 * Artikelzaehler am Heft (03.11.2026).
 *
 * Die Heftliste der Redaktion zaehlte je Heft die Artikel, indem sie alle
 * Artikel las — samt Suchtext (bis 100.000 Zeichen je Artikel). Bei 160
 * Weltkrieg-Heften ueberschritt das die Lesegrenze von Convex (16 MB je
 * Abfrage), die Liste fiel aus und mit ihr der laufende Massenimport im
 * Browser. Jetzt steht der Stand am Heft und wird von jeder Funktion neu
 * gezaehlt, die Artikel anlegt, loescht oder ihren Pruefstand aendert.
 */
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export async function artikelStandAktualisieren(
  ctx: MutationCtx,
  issueId: Id<"issues">,
): Promise<void> {
  let gesamt = 0;
  let offen = 0;
  let frei = 0;
  for await (const a of ctx.db
    .query("articles")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))) {
    gesamt++;
    if (a.reviewStatus === "pending") offen++;
    else if (a.reviewStatus === "approved") frei++;
  }
  const heft = await ctx.db.get(issueId);
  if (!heft) return;
  await ctx.db.patch(issueId, {
    articleCount: gesamt,
    artikelStand: { gesamt, offen, frei },
    updatedAt: Date.now(),
  });
}

/** Einmal fuer alle Hefte nachtragen, in Stapeln (Kommandozeile). */
export const nachtragenInternal = internalMutation({
  args: { ab: v.optional(v.number()), anzahl: v.optional(v.number()) },
  handler: async (ctx, { ab = 0, anzahl = 20 }) => {
    const hefte = await ctx.db.query("issues").order("asc").collect();
    const teil = hefte.slice(ab, ab + anzahl);
    for (const h of teil) await artikelStandAktualisieren(ctx, h._id);
    return { erledigt: teil.length, weiter: ab + anzahl < hefte.length ? ab + anzahl : null };
  },
});
