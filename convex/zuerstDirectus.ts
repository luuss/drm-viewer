import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { assetUrl } from "./assets";

/**
 * Neue ZUERST!-Ausgabe an zuerst.de melden.
 *
 * Sobald ein Heft der Reihe `zuerst` zum ersten Mal (oder nach einem
 * Zurueckziehen wieder) veroeffentlicht wird, schickt der Leser das Titelbild
 * und das Inhaltsverzeichnis an Directus (Collection `ausgaben`, Seitenleiste
 * und `/aktuelle-ausgabe/`). Es ist ein Push: der Leser stellt dafuer nichts
 * neu ins Netz.
 *
 * Der Directus-Zugang (User "Leser-Push") darf nur: neueste Ausgabe lesen
 * (id, status, erscheint_am), `content` und `cover_image` aendern, JPEG
 * hochladen. Der Token steht in `dienstGeheimnisse` unter `zuerst-directus`
 * und wird nie ausgegeben.
 *
 * Abschalten: Umgebungsvariable `ZUERST_PUSH=aus`.
 * Von Hand: `npx convex run zuerstDirectus:sendenInternal '{"issueId":"…"}'`.
 */

const GEHEIMNIS = "zuerst-directus";
const VERZUG_MS = 60 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

function abgeschaltet(): boolean {
  return (process.env.ZUERST_PUSH ?? "").trim().toLowerCase() === "aus";
}

function basis(): string {
  return (process.env.ZUERST_DIRECTUS_URL ?? "https://zuerst.de").replace(/\/$/, "");
}

// --- Inhaltsverzeichnis als HTML -------------------------------------------

export type Eintrag = { rubrik: string | null; titel: string; unterzeile: string | null };

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Text fuer Directus: maskiert, `ZUERST!` kursiv wie im Heft. */
function inline(s: string): string {
  return escape(s.replace(/\s+/g, " ").trim()).replace(/ZUERST!/g, "<em>ZUERST!</em>");
}

/**
 * Nur Eintraege mit Unterzeile kommen ins Verzeichnis. Damit fallen Editorial,
 * Politikmeldungen, Kolumne, Innere Sicherheit, Historischer Kalender,
 * Buchbesprechungen, Leserbriefe und Zuletzt von selbst weg: sie haben im
 * Heft keine Unterzeile. Gleiches Format wie bisher der Heft-Bot.
 */
export function verzeichnisHtml(eintraege: Eintrag[]): { html: string; anzahl: number } {
  const out: string[] = [];
  let rubrik: string | null = null;
  let anzahl = 0;
  for (const e of eintraege) {
    if (!e.unterzeile?.trim() || !e.titel.trim()) continue;
    const r = e.rubrik?.trim().toLocaleUpperCase("de-DE") || null;
    if (r && r !== rubrik) {
      out.push(`<h2>${inline(r)}</h2>`);
      rubrik = r;
    }
    out.push(
      `<p style="padding-left: 30px;"><strong>${inline(e.titel)}</strong><br>${inline(e.unterzeile)}</p>`,
    );
    anzahl++;
  }
  return { html: out.join("\n"), anzahl };
}

// --- Einplanen (aus publishIssue) ------------------------------------------

export async function zuerstPushPlanen(ctx: MutationCtx, issue: Doc<"issues">) {
  if (abgeschaltet()) return;
  const pub = await ctx.db.get(issue.publicationId);
  if (pub?.slug !== "zuerst") return;
  await ctx.scheduler.runAfter(VERZUG_MS, internal.zuerstDirectus.sendenInternal, {
    issueId: issue._id,
  });
}

// --- Daten sammeln -----------------------------------------------------------

function zeitpunkt(i: Doc<"issues">): number {
  return i.publicationDate ?? i.publishedAt ?? i.createdAt;
}

export const datenInternal = internalQuery({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue) return { grund: "Heft nicht gefunden" } as const;
    if (!issue.isPublished) return { grund: "Heft nicht veroeffentlicht" } as const;
    const pub = await ctx.db.get(issue.publicationId);
    if (pub?.slug !== "zuerst") return { grund: "keine ZUERST!-Ausgabe" } as const;

    // Nur die neueste veroeffentlichte Ausgabe darf zuerst.de ueberschreiben;
    // ein altes Heft, das wieder online geht, nicht.
    const hefte = await ctx.db
      .query("issues")
      .withIndex("by_publication", (q) => q.eq("publicationId", issue.publicationId))
      .take(2000);
    const neuer = hefte.find(
      (h) => h.isPublished && h._id !== issue._id && zeitpunkt(h) > zeitpunkt(issue),
    );
    if (neuer) return { grund: `neuere Ausgabe ${neuer.issueNumber ?? neuer.title} ist online` } as const;

    const toc = await ctx.db
      .query("tocEntries")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .take(1000);
    const eintraege: Eintrag[] = [];
    for (const t of toc) {
      if (t.level !== 1) continue;
      const artikel = t.articleId ? await ctx.db.get(t.articleId) : null;
      if (!artikel || artikel.reviewStatus !== "approved") continue;
      eintraege.push({
        rubrik: t.section ?? null,
        titel: t.label,
        unterzeile: artikel.subtitle ?? null,
      });
    }
    const geheimnis = await ctx.db
      .query("dienstGeheimnisse")
      .withIndex("by_name", (q) => q.eq("name", GEHEIMNIS))
      .unique();
    return {
      grund: null,
      ausgabe: issue.issueNumber ?? issue.title,
      coverUrl: await assetUrl(ctx, issue.coverAssetId),
      eintraege,
      token: geheimnis?.wert ?? null,
    } as const;
  },
});

// --- Senden ------------------------------------------------------------------

async function directus(
  token: string,
  method: string,
  pfad: string,
  body?: BodyInit,
  typ?: string,
): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": UA };
  if (typ) headers["Content-Type"] = typ;
  const r = await fetch(basis() + pfad, { method, headers, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`Directus ${method} ${pfad.split("?")[0]}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export const sendenInternal = internalAction({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }): Promise<string> => {
    const d = await ctx.runQuery(internal.zuerstDirectus.datenInternal, { issueId });
    const protokoll = async (detail: string) => {
      await ctx.runMutation(internal.zuerstDirectus.protokollInternal, { issueId, detail });
      return detail;
    };
    if (d.grund) return await protokoll(`uebersprungen: ${d.grund}`);
    if (!d.token) return await protokoll("uebersprungen: kein Zugang zuerst-directus gesetzt");
    if (!d.coverUrl) return await protokoll("Fehler: Heft ohne Titelbild");
    const { html, anzahl } = verzeichnisHtml(d.eintraege);
    if (anzahl < 10) return await protokoll(`Fehler: nur ${anzahl} Eintraege mit Unterzeile`);

    try {
      const bild = await fetch(d.coverUrl, { headers: { "User-Agent": UA } });
      if (!bild.ok) throw new Error(`Titelbild: ${bild.status}`);
      const daten = await bild.blob();

      const filter = encodeURIComponent(
        JSON.stringify({ status: { _eq: "published" }, erscheint_am: { _lte: "$NOW" } }),
      );
      const aktuell = await directus(
        d.token,
        "GET",
        `/items/ausgaben?limit=1&sort=-erscheint_am&fields=id&filter=${filter}`,
      );
      const ausgabeId = aktuell?.data?.[0]?.id;
      if (!ausgabeId) throw new Error("keine aktuelle Ausgabe in Directus");

      const form = new FormData();
      form.append("title", `ZUERST! ${d.ausgabe} Cover`);
      form.append(
        "file",
        new Blob([daten], { type: "image/jpeg" }),
        `zuerst-${d.ausgabe.replace(/\//g, "-")}.jpg`,
      );
      const datei = await directus(d.token, "POST", "/files", form);
      const dateiId = datei?.data?.id;
      if (!dateiId) throw new Error("Upload ohne Datei-ID");

      await directus(
        d.token,
        "PATCH",
        `/items/ausgaben/${ausgabeId}?fields=id`,
        JSON.stringify({ content: html, cover_image: dateiId }),
        "application/json",
      );
      return await protokoll(`ZUERST! ${d.ausgabe}: Cover ${dateiId}, ${anzahl} Eintraege`);
    } catch (e) {
      return await protokoll(`Fehler: ${(e as Error).message}`);
    }
  },
});

export const protokollInternal = internalMutation({
  args: { issueId: v.id("issues"), detail: v.string() },
  handler: async (ctx, { issueId, detail }) => {
    await ctx.db.insert("auditLog", {
      action: "zuerst.directus",
      target: issueId as Id<"issues">,
      detail,
      createdAt: Date.now(),
    });
  },
});

/** Zugang setzen. Gibt nichts zurueck, auch nicht den alten Wert. */
export const zugangSetzenInternal = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("Token sieht nicht gueltig aus");
    const alt = await ctx.db
      .query("dienstGeheimnisse")
      .withIndex("by_name", (q) => q.eq("name", GEHEIMNIS))
      .unique();
    if (alt) await ctx.db.patch(alt._id, { wert: token, gesetztAm: Date.now() });
    else await ctx.db.insert("dienstGeheimnisse", { name: GEHEIMNIS, wert: token, gesetztAm: Date.now() });
    return null;
  },
});

/** Letzte Meldungen, fuer die Kontrolle von der Kommandozeile. */
export const protokollLesenInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("auditLog")
      .withIndex("by_action", (q) => q.eq("action", "zuerst.directus"))
      .order("desc")
      .take(10);
    return rows.map((r) => ({ issueId: r.target, detail: r.detail, am: new Date(r.createdAt).toISOString() }));
  },
});
