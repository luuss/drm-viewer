import { v } from "convex/values";
import { verschluesseler } from "./schutz";
import { schutzSeedVon } from "./readerSessions";
import { absatzBeiPunkt } from "./einstieg";
import {
  internalMutation,
  MutationCtx,
  mutation,
  query,
  QueryCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, requirePublisher, audit } from "./roles";
import { hasIssueAccess, accessibleIssueIds, istRedaktion } from "./access";
import { blockType, tableData } from "./schema";
import { assetUrl } from "./assets";
import { deleteLinksForBlock, deleteLinksForIssue } from "./articleProducts";
import { internal } from "./_generated/api";
import {
  ausschnitt,
  ganzeWoerter,
  passt,
  suchwoerter,
  sucheVormerken,
  trefferRang,
} from "./suche";
import { Doc, Id } from "./_generated/dataModel";

const regionInput = v.object({
  pageIndex: v.number(),
  x0: v.number(),
  y0: v.number(),
  x1: v.number(),
  y1: v.number(),
  targetPageIndex: v.optional(v.number()),
  kind: v.optional(
    v.union(
      v.literal("body"),
      v.literal("title"),
      v.literal("image"),
      v.literal("other"),
    ),
  ),
});

const blockInput = v.object({
  order: v.number(),
  type: blockType,
  text: v.string(),
  sourcePageIndex: v.optional(v.number()),
  sourceY: v.optional(v.number()),
  sourceStoryId: v.optional(v.string()),
  sourceFrameId: v.optional(v.string()),
  styleName: v.optional(v.string()),
  confidence: v.optional(v.number()),
  table: v.optional(tableData),
});

export const articleInput = v.object({
  order: v.number(),
  title: v.string(),
  subtitle: v.optional(v.string()),
  author: v.optional(v.string()),
  teaser: v.optional(v.string()),
  source: v.union(
    v.literal("idml"),
    v.literal("pdf"),
    v.literal("manual"),
    v.literal("hybrid"),
  ),
  confidence: v.optional(v.number()),
  primaryPageIndex: v.number(),
  pageStart: v.number(),
  pageEnd: v.number(),
  blocks: v.array(blockInput),
  regions: v.array(regionInput),
  images: v.optional(
    v.array(
      v.object({
        assetId: v.id("assets"),
        caption: v.optional(v.string()),
        sourcePageIndex: v.optional(v.number()),
        sourceY: v.optional(v.number()),
        afterBlockOrder: v.optional(v.number()),
      }),
    ),
  ),
});

/** Suchtext wird aus den Bloecken abgeleitet, nie getrennt gepflegt. */
export async function rebuildSearchText(ctx: MutationCtx, articleId: Id<"articles">) {
  const article = await ctx.db.get(articleId);
  if (!article) return;
  const blocks = await ctx.db
    .query("articleBlocks")
    .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
    .collect();
  const parts = [article.title, article.subtitle ?? "", article.teaser ?? ""];
  for (const b of blocks) parts.push(b.text);
  await ctx.db.patch(articleId, {
    searchText: parts.filter(Boolean).join("\n\n").slice(0, 100000),
    updatedAt: Date.now(),
  });
  await sucheVormerken(ctx, article.issueId, articleId);
}

async function recountIssue(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  await ctx.db.patch(issueId, { articleCount: rows.length, updatedAt: Date.now() });
}

async function renumber(ctx: MutationCtx, issueId: Id<"issues">) {
  const rows = await ctx.db
    .query("articles")
    .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
    .collect();
  let i = 1;
  for (const r of rows) {
    if (r.order !== i) await ctx.db.patch(r._id, { order: i });
    i++;
  }
}

// --- Leser ---

export const listForReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    return rows
      .filter((a) => a.reviewStatus === "approved")
      .map((a) => ({
        _id: a._id,
        order: a.order,
        title: a.title,
        subtitle: a.subtitle ?? null,
        author: a.author ?? null,
        teaser: a.teaser ?? null,
        primaryPageIndex: a.primaryPageIndex,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
      }));
  },
});

/** Kleinste Klickflaeche, die noch Sinn ergibt (Anteil der Seitenkante). */
const MIN_REGION_SIZE = 0.004;
// Wie nah zwei Rahmen liegen duerfen, damit sie zu einer Klickflaeche
// zusammenwachsen. Knapp gehalten: Spaltenabstaende und der Abstand zum
// Nachbarartikel sind groesser, die Luecke zwischen Uberschrift und Text ist
// kleiner.
const REGION_GAP = 0.012;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Rechtecke desselben Artikels auf einer Seite zu wenigen Flaechen
// zusammenfassen: was sich beruehrt oder dicht beieinander liegt, wird ein
// Kasten. Die Liste ist kurz (Rahmen einer Seite), das quadratische Vorgehen
// also unkritisch.
function verschmelzen<T extends { x0: number; y0: number; x1: number; y1: number }>(
  rechtecke: T[],
): T[] {
  const offen = [...rechtecke];
  const fertig: T[] = [];
  while (offen.length > 0) {
    const gruppe = offen.shift()!;
    let gewachsen = true;
    while (gewachsen) {
      gewachsen = false;
      for (let i = offen.length - 1; i >= 0; i--) {
        const k = offen[i];
        const beruehrt =
          k.x0 <= gruppe.x1 + REGION_GAP &&
          k.x1 >= gruppe.x0 - REGION_GAP &&
          k.y0 <= gruppe.y1 + REGION_GAP &&
          k.y1 >= gruppe.y0 - REGION_GAP;
        if (!beruehrt) continue;
        gruppe.x0 = Math.min(gruppe.x0, k.x0);
        gruppe.y0 = Math.min(gruppe.y0, k.y0);
        gruppe.x1 = Math.max(gruppe.x1, k.x1);
        gruppe.y1 = Math.max(gruppe.y1, k.y1);
        offen.splice(i, 1);
        gewachsen = true;
      }
    }
    fertig.push(gruppe);
  }
  return fertig;
}

/**
 * Der Absatz unter einem Tipp im Seitenmodus. Die Artikelansicht springt
 * dorthin, statt am Anfang des Artikels zu oeffnen (`einstieg.ts`).
 */
export const absatzBeiKlick = query({
  args: {
    articleId: v.id("articles"),
    pageIndex: v.number(),
    x: v.number(),
    y: v.number(),
  },
  handler: async (ctx, { articleId, pageIndex, x, y }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const article = await ctx.db.get(articleId);
    if (!article || article.reviewStatus !== "approved") return null;
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, article.issueId))) {
      return null;
    }
    const bloecke = (
      await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
        .collect()
    ).filter((b) => b.sourcePageIndex === pageIndex);
    const rahmen = (
      await ctx.db
        .query("articleRegions")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .collect()
    ).filter(
      (r) =>
        r.pageIndex === pageIndex &&
        r.targetPageIndex === undefined &&
        (r.kind === "body" || r.kind === "title"),
    );
    const order = absatzBeiPunkt(
      bloecke.map((b) => ({ order: b.order, text: b.text, sourceY: b.sourceY })),
      rahmen,
      x,
      y,
    );
    return order === null ? null : { order };
  },
});

/** Klickflaechen im Seitenmodus, nur von freigegebenen Artikeln. */
export const regionsForReader = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, issueId))) return [];
    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    const published = new Map<string, boolean>();
    type ReaderRegion = {
      articleId: Id<"articles">;
      pageIndex: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      kind: "body" | "title" | "image" | "other";
      targetPageIndex: number | null;
    };
    const navigation: ReaderRegion[] = [];
    const articleAreas = new Map<string, ReaderRegion[]>();
    for (const r of regions) {
      const key = r.articleId as string;
      if (!published.has(key)) {
        const a = await ctx.db.get(r.articleId);
        published.set(key, a?.reviewStatus === "approved");
      }
      if (!published.get(key)) continue;
      // Die Aufbereitung liefert vereinzelt verdrehte oder ueberstehende
      // Rechtecke (x0 groesser als x1, Werte ueber 1). Sortiert und auf die
      // Seite beschnitten kommen sie hier heraus; entartete Flaechen fallen
      // weg, statt im Reader als unsichtbare Fehlklickflaeche zu liegen.
      const x0 = clamp01(Math.min(r.x0, r.x1));
      const x1 = clamp01(Math.max(r.x0, r.x1));
      const y0 = clamp01(Math.min(r.y0, r.y1));
      const y1 = clamp01(Math.max(r.y0, r.y1));
      if (x1 - x0 < MIN_REGION_SIZE || y1 - y0 < MIN_REGION_SIZE) continue;
      const normalized: ReaderRegion = {
        articleId: r.articleId,
        pageIndex: r.pageIndex,
        x0,
        y0,
        x1,
        y1,
        kind: r.kind,
        targetPageIndex: r.targetPageIndex ?? null,
      };
      if (r.targetPageIndex !== undefined) {
        // Jeder TOC-Eintrag hat sein eigenes Sprungziel und darf nicht mit
        // benachbarten Zeilen zusammenfallen.
        navigation.push(normalized);
        continue;
      }

      // Die Debugansicht behaelt alle feinen Rohregionen. Im Reader werden
      // daraus wenige ruhige Flaechen: benachbarte Rahmen desselben Artikels
      // wachsen zusammen, entfernte bleiben getrennt. Ein einziger Kasten je
      // Artikel und Seite wuerde sonst bei zwei Artikeln auf einer Seite die
      // ganze Seite belegen und den Nachbarn verdecken.
      const areaKey = `${r.articleId}:${r.pageIndex}`;
      const bisher = articleAreas.get(areaKey);
      if (bisher) bisher.push({ ...normalized, kind: "body" });
      else articleAreas.set(areaKey, [{ ...normalized, kind: "body" }]);
    }
    const flaechen: ReaderRegion[] = [];
    for (const rohe of articleAreas.values()) {
      for (const teil of verschmelzen(rohe)) flaechen.push(teil);
    }
    return [...navigation, ...flaechen];
  },
});

/**
 * Zeile einer Aufzaehlung ("– Eisernes Kreuz", "• 3. Kompanie"). Der Leser
 * sieht den Text nur verschluesselt und erkennt das Zeichen am Anfang nicht;
 * er bekommt die Angabe mit und stellt kein Bild mitten in eine Liste
 * (`web/src/reader/bildfolge.ts`).
 */
export function istListenzeile(text: string): boolean {
  return /^\s*[–—•·▪■●◦‣\-*]\s/u.test(text);
}

/** Text fuer den Vergleich von Kasten und Fliesstext: ohne Anfuehrungszeichen,
 * weiche Trennstriche und doppelte Leerzeichen, klein geschrieben. */
function vergleichstext(text: string) {
  return text
    .toLowerCase()
    .replace(/\u00ad/g, "")
    .replace(/[„“”"‚‘’'«»‹›]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kuerzere Kaesten ("Info", "Zur Person") stehen zufaellig auch im Text. */
const ZITAT_MIN = 30;

/**
 * Steht der Text eines Zitatkastens vollstaendig in einem Absatz desselben
 * Artikels? Dann ist er ein herausgestelltes Zitat, und der Leser zeigt es
 * nicht noch einmal. In Greim stand so jedes Randzitat doppelt da.
 */
export function zitatDoppelt(kasten: string, absaetze: string[]): boolean {
  const k = vergleichstext(kasten).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (k.length < ZITAT_MIN) return false;
  return absaetze.some((a) => vergleichstext(a).includes(k));
}

export const getForReader = query({
  args: { articleId: v.id("articles"), sessionToken: v.optional(v.string()) },
  handler: async (ctx, { articleId, sessionToken }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !sessionToken) return null;
    const article = await ctx.db.get(articleId);
    if (!article) return null;
    // Text nur zu einer gueltigen Lesesitzung dieses Lesers und Hefts. Ihr
    // Geheimwert bestimmt die Verschluesselung (`schutz.ts`); ohne Sitzung
    // gibt es keinen Klartext.
    const sitzung = await ctx.db
      .query("readerSessions")
      .withIndex("by_token", (q) => q.eq("sessionToken", sessionToken))
      .unique();
    if (
      !sitzung ||
      sitzung.userId !== userId ||
      sitzung.issueId !== article.issueId ||
      sitzung.expiresAt < Date.now()
    ) {
      return null;
    }
    const enc = verschluesseler(schutzSeedVon(sitzung), articleId);
    const encOpt = (text: string | null | undefined) => (text ? enc(text) : null);
    if (!(await hasIssueAccess(ctx, userId as Id<"users">, article.issueId))) {
      return null;
    }
    // Sichtbar sind freigegebene Artikel veroeffentlichter Ausgaben. Die
    // Redaktion sieht ein frisch hochgeladenes Heft schon vor der
    // Veroeffentlichung; Seiten und Artikelliste zeigt der Reader ihr ohnehin.
    if (article.reviewStatus !== "approved") return null;
    const issue = await ctx.db.get(article.issueId);
    if (!issue) return null;
    if (!issue.isPublished && !(await istRedaktion(ctx, userId as Id<"users">))) {
      return null;
    }

    const blocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
      .collect();
    const images = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    const withUrls = [];
    for (const img of images.sort((a, b) => a.order - b.order)) {
      // Ueber `assetUrl`, damit auch Bilder aus dem Medienspeicher eine
      // Adresse bekommen — dort fuehrt der Weg ueber das Kachel-Gateway.
      const url = await assetUrl(ctx, img.assetId);
      if (url) {
        // Die Groesse geht mit: ohne sie zieht der Reader jedes Bild auf
        // Spaltenbreite, auch ein kleines, und das sieht unscharf aus.
        const asset = await ctx.db.get(img.assetId);
        withUrls.push({
          url,
          caption: encOpt(img.caption),
          page: img.sourcePageIndex ?? null,
          sourceY: img.sourceY ?? null,
          afterBlockOrder: img.afterBlockOrder ?? null,
          width: asset?.width ?? null,
          height: asset?.height ?? null,
        });
      }
    }
    const fliesstext = blocks
      .filter((b) => b.type === "paragraph" || b.type === "lead")
      .map((b) => b.text);
    return {
      _id: article._id,
      issueId: article.issueId,
      order: article.order,
      title: enc(article.title),
      subtitle: encOpt(article.subtitle),
      author: encOpt(article.author),
      teaser: encOpt(article.teaser),
      primaryPageIndex: article.primaryPageIndex,
      pageStart: article.pageStart,
      pageEnd: article.pageEnd,
      blocks: blocks.map((b) => ({
        // Anker fuer Bestellknoepfe (articleProducts.forReader: `blockOrder`).
        order: b.order,
        type: b.type,
        text: enc(b.text),
        liste: istListenzeile(b.text),
        // Kasten oder Zitat, das schon im Fliesstext steht: nicht noch einmal.
        doppelt: (b.type === "box" || b.type === "quote") && zitatDoppelt(b.text, fliesstext),
        page: b.sourcePageIndex ?? null,
        sourceY: b.sourceY ?? null,
        // Zahlen bleiben in Tabellen lesbar: daran erkennt der Reader
        // Zahlenspalten und richtet sie rechts aus.
        table:
          b.type === "table" && b.table
            ? {
                ...b.table,
                rows: b.table.rows.map((row) =>
                  row.map((c) => ({ ...c, text: enc(c.text, { zahlenLassen: true }) })),
                ),
              }
            : null,
      })),
      images: withUrls,
    };
  },
});

/** Treffer je Abruf; "Weitere Treffer" holt die naechsten dazu. */
const SUCHE_SEITE = 25;
/**
 * So viele Stuecke liest eine Suche hoechstens. Gerankt wird ueber alle, damit
 * "Weitere Treffer" die Reihenfolge der schon gezeigten nicht umstellt.
 */
const SUCHE_TIEFE = 256;

/**
 * Wo im Artikel der Begriff steht: der erste Absatz mit allen Teilen als
 * ganze Woerter, sonst der erste, der ueberhaupt passt. Der Titel steht im
 * Kopf des Artikels und ist keine Fundstelle. Null, wenn nur Titel oder
 * Unterzeile passen.
 */
async function fundstelle(ctx: QueryCtx, articleId: Id<"articles">, begriff: string) {
  let erster = true;
  let ungefaehr: Doc<"articleBlocks"> | null = null;
  // Kaesten und Zitate zuletzt: ein Randzitat wiederholt oft einen Absatz
  // und wird dann im Leser gar nicht gezeigt (getForReader, `doppelt`).
  let kasten: Doc<"articleBlocks"> | null = null;
  for await (const b of ctx.db
    .query("articleBlocks")
    .withIndex("by_article_order", (q) => q.eq("articleId", articleId))) {
    const titel = erster && b.type === "heading";
    erster = false;
    if (titel) continue;
    if (b.type === "box" || b.type === "quote") {
      if (!kasten && passt(b.text, begriff)) kasten = b;
      continue;
    }
    if (ganzeWoerter(b.text, begriff)) return b;
    if (!ungefaehr && passt(b.text, begriff)) ungefaehr = b;
  }
  return ungefaehr ?? kasten;
}

/**
 * Volltext der Hefte, auf die der Leser Zugriff hat, mit Ausschnitt. Gesucht
 * wird in den Stuecken aus `suche.ts`, nicht in den Artikeln selbst.
 *
 * Reihenfolge: erst ganze Woerter im Titel, dann ganze Woerter im Text, dann
 * Wortanfaenge ("Euro" vor "Europa", `trefferRang`); im selben Rang das
 * neuere Heft zuerst, dann die Relevanz aus dem Suchindex. Jeder Treffer
 * nennt den Absatz der Fundstelle (`stelle`), der Leser springt dorthin.
 * Bis `limit` Treffer, `gesamt` zaehlt alle gefundenen; `vollstaendig` ist
 * falsch, wenn die Suche an ihre Tiefe stiess und es noch mehr geben kann.
 */
export const search = query({
  args: {
    term: v.string(),
    issueId: v.optional(v.id("issues")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { term, issueId, limit }) => {
    const userId = await getAuthUserId(ctx);
    const begriff = term.trim();
    const woerter = suchwoerter(begriff);
    if (!userId || begriff.length < 3 || !woerter) {
      return { treffer: [], gesamt: 0, vollstaendig: true };
    }
    const allowed = await accessibleIssueIds(ctx, userId as Id<"users">);
    // Jeder Aufrufer darf `limit` setzen; mehr als vier Seiten auf einmal liest
    // die Suche nicht (je Treffer werden die Absaetze fuer die Fundstelle gelesen).
    const anzahl = Math.max(1, Math.min(4 * SUCHE_SEITE, Math.floor(limit ?? SUCHE_SEITE)));

    const hits = await ctx.db
      .query("searchChunks")
      .withSearchIndex("search_text", (q) => {
        const base = q.search("text", woerter);
        return issueId ? base.eq("issueId", issueId) : base;
      })
      .take(SUCHE_TIEFE);

    const hefte = new Map<string, Doc<"issues"> | null>();
    // Je Artikel das beste Stueck: niedrigster Rang, bei Gleichstand das
    // relevantere (fruehere) aus dem Index.
    const beste = new Map<string, { c: Doc<"searchChunks">; rang: number; pos: number }>();
    for (const [pos, c] of hits.entries()) {
      if (!allowed.has(c.issueId as string) || !passt(c.text, begriff)) continue;
      if (!hefte.has(c.issueId as string)) hefte.set(c.issueId as string, await ctx.db.get(c.issueId));
      if (!hefte.get(c.issueId as string)?.isPublished) continue;
      const rang = trefferRang(c.title, c.text, begriff);
      const bisher = beste.get(c.articleId as string);
      if (!bisher) beste.set(c.articleId as string, { c, rang, pos });
      else if (rang < bisher.rang) beste.set(c.articleId as string, { c, rang, pos: bisher.pos });
    }
    const datum = (i: Doc<"issues">) => i.publicationDate ?? i.publishedAt ?? i.createdAt;
    const sortiert = [...beste.values()].sort(
      (a, b) =>
        a.rang - b.rang ||
        datum(hefte.get(b.c.issueId as string)!) - datum(hefte.get(a.c.issueId as string)!) ||
        a.pos - b.pos,
    );

    const treffer = [];
    for (const { c } of sortiert.slice(0, anzahl)) {
      const issue = hefte.get(c.issueId as string)!;
      const stelle = await fundstelle(ctx, c.articleId, begriff);
      const pageIndex = stelle?.sourcePageIndex ?? c.pageIndex;
      // Gedruckte Seitenzahl, nicht die Stelle in der Leserfolge.
      const seite = await ctx.db
        .query("issuePages")
        .withIndex("by_issue_index", (q) => q.eq("issueId", c.issueId).eq("index", pageIndex))
        .unique();
      treffer.push({
        _id: c.articleId,
        issueId: c.issueId,
        issueTitle: issue.title,
        title: c.title,
        pageIndex,
        page: seite?.printedLabel || String(pageIndex + 1),
        stelle: stelle?.order ?? null,
        snippet: ausschnitt(stelle?.text ?? c.text, begriff),
      });
    }
    return {
      treffer,
      gesamt: sortiert.length,
      vollstaendig: hits.length < SUCHE_TIEFE,
    };
  },
});

// --- Redaktion ---

export const listForEditors = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue_order", (q) => q.eq("issueId", issueId))
      .collect();
    return Promise.all(
      rows.map(async (a) => {
        const blocks = await ctx.db
          .query("articleBlocks")
          .withIndex("by_article_order", (q) => q.eq("articleId", a._id))
          .collect();
        const regions = await ctx.db
          .query("articleRegions")
          .withIndex("by_article", (q) => q.eq("articleId", a._id))
          .collect();
        const images = await ctx.db
          .query("articleAssets")
          .withIndex("by_article", (q) => q.eq("articleId", a._id))
          .collect();
        return {
          _id: a._id,
          order: a.order,
          title: a.title,
          subtitle: a.subtitle ?? null,
          author: a.author ?? null,
          teaser: a.teaser ?? null,
          source: a.source,
          reviewStatus: a.reviewStatus,
          confidence: a.confidence ?? null,
          primaryPageIndex: a.primaryPageIndex,
          pageStart: a.pageStart,
          pageEnd: a.pageEnd,
          charCount: blocks.reduce((n, b) => n + b.text.length, 0),
          blocks: blocks.map((b) => ({
            _id: b._id,
            order: b.order,
            type: b.type,
            text: b.text,
            sourcePageIndex: b.sourcePageIndex ?? null,
            table: b.table ?? null,
          })),
          regions: regions.map((r) => ({
            _id: r._id,
            pageIndex: r.pageIndex,
            x0: r.x0,
            y0: r.y0,
            x1: r.x1,
            y1: r.y1,
            kind: r.kind,
            targetPageIndex: r.targetPageIndex ?? null,
          })),
          images: images
            .sort((left, right) => left.order - right.order)
            .map((image) => ({
              order: image.order,
              caption: image.caption ?? null,
              sourcePageIndex: image.sourcePageIndex ?? null,
              afterBlockOrder: image.afterBlockOrder ?? null,
            })),
        };
      }),
    );
  },
});

export const updateArticle = mutation({
  args: {
    articleId: v.id("articles"),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    author: v.optional(v.string()),
    teaser: v.optional(v.string()),
    primaryPageIndex: v.optional(v.number()),
  },
  handler: async (ctx, { articleId, ...patch }) => {
    await requireEditor(ctx);
    const clean: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) clean[k] = val;
    }
    await ctx.db.patch(articleId, clean);
    await rebuildSearchText(ctx, articleId);
  },
});

export const updateBlock = mutation({
  args: {
    blockId: v.id("articleBlocks"),
    text: v.optional(v.string()),
    type: v.optional(blockType),
  },
  handler: async (ctx, { blockId, text, type }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) throw new Error("Block nicht gefunden");
    // Der Text eines Tabellenblocks ist nur der flache Suchtext; geaendert
    // wuerde er von der Tabelle abweichen, die der Leser sieht.
    if (block.type === "table" && text !== undefined && text !== block.text) {
      throw new Error("Tabellen lassen sich hier nicht als Text bearbeiten");
    }
    if (type !== undefined && (type === "table") !== (block.type === "table")) {
      throw new Error("Eine Tabelle bleibt eine Tabelle, ein Absatz ein Absatz");
    }
    const clean: Record<string, unknown> = {};
    if (text !== undefined) clean.text = text;
    if (type !== undefined) clean.type = type;
    await ctx.db.patch(blockId, clean);
    await rebuildSearchText(ctx, block.articleId);
  },
});

export const deleteBlock = mutation({
  args: { blockId: v.id("articleBlocks") },
  handler: async (ctx, { blockId }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) return;
    await deleteLinksForBlock(ctx, blockId);
    await ctx.db.delete(blockId);
    await rebuildSearchText(ctx, block.articleId);
  },
});

/** Block innerhalb des Artikels verschieben oder in einen anderen Artikel. */
export const moveBlock = mutation({
  args: {
    blockId: v.id("articleBlocks"),
    targetArticleId: v.optional(v.id("articles")),
    direction: v.optional(v.union(v.literal("up"), v.literal("down"))),
  },
  handler: async (ctx, { blockId, targetArticleId, direction }) => {
    await requireEditor(ctx);
    const block = await ctx.db.get(blockId);
    if (!block) throw new Error("Block nicht gefunden");

    if (targetArticleId && targetArticleId !== block.articleId) {
      const target = await ctx.db.get(targetArticleId);
      if (!target) throw new Error("Zielartikel nicht gefunden");
      if (target.issueId !== block.issueId) {
        throw new Error("Zielartikel gehoert zu einer anderen Ausgabe");
      }
      const targetBlocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article_order", (q) => q.eq("articleId", targetArticleId))
        .collect();
      await ctx.db.patch(blockId, {
        articleId: targetArticleId,
        order: targetBlocks.length + 1,
      });
      await rebuildSearchText(ctx, block.articleId);
      await rebuildSearchText(ctx, targetArticleId);
      return;
    }

    if (!direction) return;
    const siblings = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", block.articleId))
      .collect();
    const pos = siblings.findIndex((b) => b._id === blockId);
    const swapWith = direction === "up" ? pos - 1 : pos + 1;
    if (swapWith < 0 || swapWith >= siblings.length) return;
    const other = siblings[swapWith];
    await ctx.db.patch(blockId, { order: other.order });
    await ctx.db.patch(other._id, { order: block.order });
    await rebuildSearchText(ctx, block.articleId);
  },
});

export const mergeArticles = mutation({
  args: { targetId: v.id("articles"), sourceId: v.id("articles") },
  handler: async (ctx, { targetId, sourceId }) => {
    await requireEditor(ctx);
    const target = await ctx.db.get(targetId);
    const source = await ctx.db.get(sourceId);
    if (!target || !source) throw new Error("Artikel nicht gefunden");
    if (target.issueId !== source.issueId) {
      throw new Error("Artikel gehoeren zu verschiedenen Ausgaben");
    }

    const targetBlocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", targetId))
      .collect();
    const sourceBlocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", sourceId))
      .collect();
    let order = targetBlocks.length + 1;
    for (const b of sourceBlocks) {
      await ctx.db.patch(b._id, { articleId: targetId, order: order++ });
    }

    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_article", (q) => q.eq("articleId", sourceId))
      .collect();
    for (const r of regions) await ctx.db.patch(r._id, { articleId: targetId });

    const images = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", sourceId))
      .collect();
    for (const img of images) await ctx.db.patch(img._id, { articleId: targetId });

    await ctx.db.patch(targetId, {
      pageStart: Math.min(target.pageStart, source.pageStart),
      pageEnd: Math.max(target.pageEnd, source.pageEnd),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(sourceId);
    await rebuildSearchText(ctx, targetId);
    await renumber(ctx, target.issueId);
    await recountIssue(ctx, target.issueId);
    await audit(ctx, "article.merge", targetId, `aus ${sourceId}`);
  },
});

/**
 * Teilt an einer Blockgrenze. Regionen wandern anhand der Seiten der Bloecke
 * mit, statt beiden Teilen alle Flaechen zu vererben — genau der Fehler des
 * alten Zeichenversatz-Splits.
 */
export const splitAtBlock = mutation({
  args: {
    articleId: v.id("articles"),
    firstBlockOfSecond: v.id("articleBlocks"),
    newTitle: v.optional(v.string()),
  },
  handler: async (ctx, { articleId, firstBlockOfSecond, newTitle }) => {
    await requireEditor(ctx);
    const article = await ctx.db.get(articleId);
    if (!article) throw new Error("Artikel nicht gefunden");
    const blocks = await ctx.db
      .query("articleBlocks")
      .withIndex("by_article_order", (q) => q.eq("articleId", articleId))
      .collect();
    const cut = blocks.findIndex((b) => b._id === firstBlockOfSecond);
    if (cut <= 0) throw new Error("Trennstelle liegt nicht innerhalb des Artikels");

    const head = blocks.slice(0, cut);
    const tail = blocks.slice(cut);
    const tailPages = new Set(
      tail.map((b) => b.sourcePageIndex).filter((p): p is number => p !== undefined),
    );
    const headPages = new Set(
      head.map((b) => b.sourcePageIndex).filter((p): p is number => p !== undefined),
    );

    const title =
      newTitle?.trim() ||
      tail.find((b) => b.type === "heading")?.text ||
      `${article.title} (Fortsetzung)`;

    const now = Date.now();
    const newId = await ctx.db.insert("articles", {
      issueId: article.issueId,
      order: article.order + 0.5,
      title: title.slice(0, 300),
      source: article.source,
      reviewStatus: "pending",
      primaryPageIndex: Math.min(...(tailPages.size ? [...tailPages] : [article.primaryPageIndex])),
      pageStart: Math.min(...(tailPages.size ? [...tailPages] : [article.pageStart])),
      pageEnd: Math.max(...(tailPages.size ? [...tailPages] : [article.pageEnd])),
      searchText: "",
      createdAt: now,
      updatedAt: now,
    });

    let order = 1;
    for (const b of tail) {
      await ctx.db.patch(b._id, { articleId: newId, order: order++ });
    }

    const regions = await ctx.db
      .query("articleRegions")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const r of regions) {
      const inTail = tailPages.has(r.pageIndex);
      const inHead = headPages.has(r.pageIndex);
      if (inTail && !inHead) await ctx.db.patch(r._id, { articleId: newId });
    }

    const images = await ctx.db
      .query("articleAssets")
      .withIndex("by_article", (q) => q.eq("articleId", articleId))
      .collect();
    for (const img of images) {
      if (img.sourcePageIndex !== undefined && tailPages.has(img.sourcePageIndex)) {
        await ctx.db.patch(img._id, { articleId: newId });
      }
    }

    if (headPages.size > 0) {
      await ctx.db.patch(articleId, {
        pageStart: Math.min(...headPages),
        pageEnd: Math.max(...headPages),
        updatedAt: now,
      });
    }

    await rebuildSearchText(ctx, articleId);
    await rebuildSearchText(ctx, newId);
    await renumber(ctx, article.issueId);
    await recountIssue(ctx, article.issueId);
    await audit(ctx, "article.split", articleId, `neu ${newId}`);
    return newId;
  },
});

export const moveRegion = mutation({
  args: { regionId: v.id("articleRegions"), targetArticleId: v.id("articles") },
  handler: async (ctx, { regionId, targetArticleId }) => {
    await requireEditor(ctx);
    const region = await ctx.db.get(regionId);
    const target = await ctx.db.get(targetArticleId);
    if (!region || !target) throw new Error("Nicht gefunden");
    if (region.issueId !== target.issueId) {
      throw new Error("Andere Ausgabe");
    }
    await ctx.db.patch(regionId, { articleId: targetArticleId });
  },
});

/**
 * Redaktionelle Entscheidung. Es gibt keinen eigenen Artikel-Publish: was
 * freigegeben ist, wird mit der Ausgabe sichtbar — und Aenderungen daran sind
 * bei einer veroeffentlichten Ausgabe sofort live.
 */
/** Titel ohne Anmeldung setzen — fuer Werkzeuge mit Deploy-Schluessel (`npx convex run`). */
export const setTitleInternal = internalMutation({
  args: { articleId: v.id("articles"), title: v.string() },
  handler: async (ctx, { articleId, title }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return;
    const neu = title.trim().slice(0, 300);
    // Der Suchtext beginnt mit dem Titel; er folgt mit.
    const rest = article.searchText.startsWith(article.title)
      ? article.searchText.slice(article.title.length)
      : "\n\n" + article.searchText;
    await ctx.db.patch(articleId, {
      title: neu,
      searchText: (neu + rest).slice(0, 100000),
      updatedAt: Date.now(),
    });
    await sucheVormerken(ctx, article.issueId, articleId);
  },
});

/** Freigabe ohne Anmeldung — fuer Werkzeuge mit Deploy-Schluessel (`npx convex run`). */
export const setReviewStatusInternal = internalMutation({
  args: {
    articleId: v.id("articles"),
    reviewStatus: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("excluded"),
    ),
  },
  handler: async (ctx, { articleId, reviewStatus }) => {
    await ctx.db.patch(articleId, { reviewStatus, updatedAt: Date.now() });
    const geaendert = await ctx.db.get(articleId);
    if (geaendert) await sucheVormerken(ctx, geaendert.issueId, articleId);
  },
});

export const setReviewStatus = mutation({
  args: {
    articleId: v.id("articles"),
    reviewStatus: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("excluded"),
    ),
  },
  handler: async (ctx, { articleId, reviewStatus }) => {
    await requireEditor(ctx);
    await ctx.db.patch(articleId, { reviewStatus, updatedAt: Date.now() });
    const geaendert = await ctx.db.get(articleId);
    if (geaendert) await sucheVormerken(ctx, geaendert.issueId, articleId);
    await audit(ctx, `article.review.${reviewStatus}`, articleId);
  },
});

/**
 * Obergrenze je Aufruf. Nach dem Import stehen alle Artikel eines Hefts offen;
 * einzeln freigeben ist bei siebzig Artikeln unzumutbar. Eine Mutation darf
 * aber nicht unbegrenzt schreiben, deshalb der Deckel — was darueber liegt,
 * holt der naechste Aufruf.
 */
const APPROVE_ALL_LIMIT = 500;

/** Alle offenen Artikel einer Ausgabe auf einmal freigeben. */
export const approveAllPending = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const pendingQuery = () =>
      ctx.db
        .query("articles")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .filter((q) => q.eq(q.field("reviewStatus"), "pending"));

    const rows = await pendingQuery().take(APPROVE_ALL_LIMIT);
    const now = Date.now();
    for (const r of rows) {
      // Genau wie setReviewStatus: nur der Artikel wird angefasst. Die Zaehler
      // am Heft (articleCount) haengen an der Anzahl, nicht am Status, und
      // duerfen hier nicht angefasst werden.
      await ctx.db.patch(r._id, { reviewStatus: "approved", updatedAt: now });
      await sucheVormerken(ctx, issueId, r._id);
    }

    // Nach dem Deckel kann noch etwas offen sein. Das meldet die Pruefansicht,
    // statt stillschweigend eine halb freigegebene Ausgabe zu hinterlassen.
    const remaining = (await pendingQuery().first()) !== null;
    await audit(
      ctx,
      "article.review.approveAll",
      issueId,
      `${rows.length} Artikel${remaining ? ", weitere offen" : ""}`,
    );
    return { approved: rows.length, remaining };
  },
});

/** Zaehlt offene Entscheidungen — das Veroeffentlichungs-Gate haengt daran. */
export const reviewSummary = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const rows = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    return {
      total: rows.length,
      pending: rows.filter((r) => r.reviewStatus === "pending").length,
      approved: rows.filter((r) => r.reviewStatus === "approved").length,
      excluded: rows.filter((r) => r.reviewStatus === "excluded").length,
    };
  },
});

export const removeArticle = mutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    await requireEditor(ctx);
    const article = await ctx.db.get(articleId);
    if (!article) return;
    for (const table of ["articleBlocks", "articleRegions", "articleAssets"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_article", (q: any) => q.eq("articleId", articleId))
        .collect();
      for (const r of rows) {
        if (table === "articleBlocks") await deleteLinksForBlock(ctx, r._id as Id<"articleBlocks">);
        await ctx.db.delete(r._id);
      }
    }
    await ctx.db.delete(articleId);
    await sucheVormerken(ctx, article.issueId, articleId);
    await renumber(ctx, article.issueId);
    await recountIssue(ctx, article.issueId);
  },
});

/** Artikel ohne Anmeldung entfernen — fuer Werkzeuge mit Deploy-Schluessel (`npx convex run`). */
export const removeInternal = internalMutation({
  args: { articleId: v.id("articles") },
  handler: async (ctx, { articleId }) => {
    const article = await ctx.db.get(articleId);
    if (!article) return;
    for (const table of ["articleBlocks", "articleRegions", "articleAssets"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_article", (q: any) => q.eq("articleId", articleId))
        .collect();
      for (const r of rows) {
        if (table === "articleBlocks") await deleteLinksForBlock(ctx, r._id as Id<"articleBlocks">);
        await ctx.db.delete(r._id);
      }
    }
    await ctx.db.delete(articleId);
    await sucheVormerken(ctx, article.issueId, articleId);
    await renumber(ctx, article.issueId);
    await recountIssue(ctx, article.issueId);
  },
});

// --- Import ---

export const replaceForIssueInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    replace: v.boolean(),
    articles: v.array(articleInput),
  },
  handler: async (ctx, { issueId, replace, articles }): Promise<{ ids: Id<"articles">[] }> => {
    const ids: Id<"articles">[] = [];
    if (replace) {
      const old = await ctx.db
        .query("articles")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .collect();
      for (const a of old) {
        for (const table of ["articleBlocks", "articleRegions", "articleAssets"] as const) {
          const rows = await ctx.db
            .query(table)
            .withIndex("by_article", (q: any) => q.eq("articleId", a._id))
            .collect();
          for (const r of rows) await ctx.db.delete(r._id);
        }
        await ctx.db.delete(a._id);
        await sucheVormerken(ctx, issueId, a._id);
      }
      await deleteLinksForIssue(ctx, issueId);
    }

    const now = Date.now();
    for (const a of articles) {
      const searchText = [a.title, a.subtitle ?? "", a.teaser ?? "", ...a.blocks.map((b) => b.text)]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 100000);
      const articleId = await ctx.db.insert("articles", {
        issueId,
        order: a.order,
        title: a.title.slice(0, 300),
        subtitle: a.subtitle,
        author: a.author,
        teaser: a.teaser,
        source: a.source,
        // Import landet immer als offene Entscheidung, nichts geht ungeprueft live.
        reviewStatus: "pending",
        confidence: a.confidence,
        primaryPageIndex: a.primaryPageIndex,
        pageStart: a.pageStart,
        pageEnd: a.pageEnd,
        searchText,
        createdAt: now,
        updatedAt: now,
      });
      ids.push(articleId);
      for (const b of a.blocks) {
        await ctx.db.insert("articleBlocks", {
          articleId,
          issueId,
          order: b.order,
          type: b.type,
          text: b.text,
          sourcePageIndex: b.sourcePageIndex,
          sourceY: b.sourceY,
          sourceStoryId: b.sourceStoryId,
          sourceFrameId: b.sourceFrameId,
          styleName: b.styleName,
          confidence: b.confidence,
          table: b.table,
        });
      }
      for (const [i, r] of a.regions.entries()) {
        await ctx.db.insert("articleRegions", {
          articleId,
          issueId,
          pageIndex: r.pageIndex,
          x0: r.x0,
          y0: r.y0,
          x1: r.x1,
          y1: r.y1,
          kind: r.kind ?? "body",
          targetPageIndex: r.targetPageIndex,
          order: i,
        });
      }
      for (const [i, img] of (a.images ?? []).entries()) {
        await ctx.db.insert("articleAssets", {
          articleId,
          issueId,
          assetId: img.assetId,
          order: i,
          caption: img.caption,
          sourcePageIndex: img.sourcePageIndex,
          sourceY: img.sourceY,
          afterBlockOrder: img.afterBlockOrder,
        });
      }
    }

    const all = await ctx.db
      .query("articles")
      .withIndex("by_issue", (q) => q.eq("issueId", issueId))
      .collect();
    await ctx.db.patch(issueId, { articleCount: all.length, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.articleProducts.matchInternal, { issueId });
    return { ids };
  },
});

/**
 * Bloecke, Flaechen und Bilder in einen anderen Artikel desselben Hefts
 * ruecken — fuer Werkzeuge mit Deploy-Schluessel (`npx convex run`), wenn der
 * Import eine Ueberschrift zum falschen Text oder ein Bild zum Nachbarn
 * gelegt hat. Nichts wird geloescht: die Zeilen wechseln nur den Artikel.
 * Verschobene Bloecke reihen sich hinter den vorhandenen ein (bei einem
 * Tausch ganzer Textkoerper bleibt so ihre Folge), Bilder ordnen sich nach
 * Seite und Lage, und der Suchtext aller beruehrten Artikel wird neu gebaut.
 */
export const moveContentInternal = internalMutation({
  args: {
    toArticleId: v.id("articles"),
    blockIds: v.optional(v.array(v.id("articleBlocks"))),
    regionIds: v.optional(v.array(v.id("articleRegions"))),
    assetIds: v.optional(v.array(v.id("articleAssets"))),
  },
  handler: async (
    ctx,
    { toArticleId, blockIds = [], regionIds = [], assetIds = [] },
  ) => {
    const ziel = await ctx.db.get(toArticleId);
    if (!ziel) throw new Error("Zielartikel nicht gefunden");
    const beruehrt = new Set<Id<"articles">>([toArticleId]);
    const bewegt = new Set<string>();

    for (const id of blockIds) {
      const row = await ctx.db.get(id);
      if (!row) throw new Error(`Block ${id} nicht gefunden`);
      if (row.issueId !== ziel.issueId) throw new Error("Block aus anderer Ausgabe");
      beruehrt.add(row.articleId);
      bewegt.add(id);
      await ctx.db.patch(id, { articleId: toArticleId });
    }
    for (const id of regionIds) {
      const row = await ctx.db.get(id);
      if (!row) throw new Error(`Flaeche ${id} nicht gefunden`);
      if (row.issueId !== ziel.issueId) throw new Error("Flaeche aus anderer Ausgabe");
      beruehrt.add(row.articleId);
      bewegt.add(id);
      await ctx.db.patch(id, { articleId: toArticleId });
    }
    for (const id of assetIds) {
      const row = await ctx.db.get(id);
      if (!row) throw new Error(`Bild ${id} nicht gefunden`);
      if (row.issueId !== ziel.issueId) throw new Error("Bild aus anderer Ausgabe");
      beruehrt.add(row.articleId);
      bewegt.add(id);
      await ctx.db.patch(id, { articleId: toArticleId });
    }

    for (const articleId of beruehrt) {
      const blocks = await ctx.db
        .query("articleBlocks")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .collect();
      // Zugezogene hinter die vorhandenen, in ihrer alten Folge.
      blocks.sort(
        (a, b) =>
          Number(bewegt.has(a._id)) - Number(bewegt.has(b._id)) || a.order - b.order,
      );
      for (const [i, b] of blocks.entries()) {
        if (b.order !== i + 1) await ctx.db.patch(b._id, { order: i + 1 });
      }
      const regions = await ctx.db
        .query("articleRegions")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .collect();
      regions.sort(
        (a, b) =>
          Number(bewegt.has(a._id)) - Number(bewegt.has(b._id)) ||
          (a.order ?? 0) - (b.order ?? 0),
      );
      for (const [i, r] of regions.entries()) {
        if (r.order !== i) await ctx.db.patch(r._id, { order: i });
      }
      const assets = await ctx.db
        .query("articleAssets")
        .withIndex("by_article", (q) => q.eq("articleId", articleId))
        .collect();
      assets.sort(
        (a, b) =>
          (a.sourcePageIndex ?? 0) - (b.sourcePageIndex ?? 0) ||
          (a.sourceY ?? 0) - (b.sourceY ?? 0) ||
          a.order - b.order,
      );
      for (const [i, x] of assets.entries()) {
        if (x.order !== i) await ctx.db.patch(x._id, { order: i });
      }
      await rebuildSearchText(ctx, articleId);
    }
    return { articles: beruehrt.size, moved: bewegt.size };
  },
});

/** Blocktext ohne Anmeldung berichtigen — fuer Werkzeuge mit Deploy-Schluessel. */
export const setBlockTextInternal = internalMutation({
  args: { blockId: v.id("articleBlocks"), text: v.string() },
  handler: async (ctx, { blockId, text }) => {
    const block = await ctx.db.get(blockId);
    if (!block) throw new Error("Block nicht gefunden");
    await ctx.db.patch(blockId, { text });
    await rebuildSearchText(ctx, block.articleId);
  },
});
