import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { requireEditor } from "./roles";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  SHOP_URL,
  categoryUrl,
  coverCandidates,
  designationMatches,
  parseMagazineStrip,
  parseProductCards,
  parseProductPage,
  searchQueryForIssue,
  searchUrl,
  seriesFor,
  type ProductCard,
  type Series,
  type StripEntry,
} from "./shopCovers";

const USER_AGENT = "LesenUndSchenkenDigital/1.0 (+https://d.chuk.dev)";

async function getText(url: string): Promise<string | null> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  return response.ok ? await response.text() : null;
}

export const listInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("publications").collect();
    return rows
      .filter((p) => p.isActive)
      .map((p) => ({
        _id: p._id,
        slug: p.slug,
        coverSource: p.coverSource ?? null,
        coverAssetId: p.coverAssetId ?? null,
        currentIssueUrl: p.currentIssueUrl ?? null,
      }));
  },
});

/** Veroeffentlichte Hefte eines Titels, die im Shop noch nicht zugeordnet sind. */
export const unlabeledIssuesInternal = internalQuery({
  args: { publicationId: v.id("publications") },
  handler: async (ctx, { publicationId }) => {
    const rows = await ctx.db
      .query("issues")
      .withIndex("by_publication", (q) => q.eq("publicationId", publicationId))
      .collect();
    // Alle Hefte mit Nummer, auch die schon zugeordneten: der Laden fuehrt
    // den Verkaufspreis, und der aendert sich. Wer eine Zuordnung hat, wird
    // ueber seine Adresse geholt statt ueber die Suche.
    return rows
      .filter((i) => i.issueNumber)
      .map((i) => ({
        _id: i._id,
        issueNumber: i.issueNumber as string,
        title: i.title,
        shopUrl: i.shopUrl,
      }));
  },
});

/** Neues Titelbild eintragen; das vorige verschwindet samt Datei. */
export const setCoverInternal = internalMutation({
  args: {
    publicationId: v.id("publications"),
    storageId: v.id("_storage"),
    contentType: v.string(),
    bytes: v.number(),
    source: v.string(),
    label: v.string(),
    imageId: v.string(),
  },
  handler: async (ctx, args) => {
    const publication = await ctx.db.get(args.publicationId);
    if (!publication) throw new Error("Titel nicht gefunden");
    const now = Date.now();
    const assetId = await ctx.db.insert("assets", {
      key: `publications/${args.publicationId}/cover-${args.imageId}.jpg`,
      contentType: args.contentType,
      bytes: args.bytes,
      kind: "cover",
      convexStorageId: args.storageId,
      createdAt: now,
    });
    await ctx.db.patch(args.publicationId, {
      coverAssetId: assetId,
      coverSource: args.source,
      coverLabel: args.label,
      coverUpdatedAt: now,
    });
    if (publication.coverAssetId) {
      const old = await ctx.db.get(publication.coverAssetId);
      if (old) {
        if (old.convexStorageId) await ctx.storage.delete(old.convexStorageId);
        await ctx.db.delete(old._id);
      }
    }
    return assetId;
  },
});

export const setCurrentIssueInternal = internalMutation({
  args: {
    publicationId: v.id("publications"),
    name: v.string(),
    designation: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    url: v.string(),
  },
  handler: async (ctx, { publicationId, name, designation, subtitle, url }) => {
    await ctx.db.patch(publicationId, {
      currentIssueName: name,
      currentIssueDesignation: designation,
      currentIssueSubtitle: subtitle,
      currentIssueUrl: url,
    });
  },
});

export const setIssueShopLabelsInternal = internalMutation({
  args: {
    issueId: v.id("issues"),
    title: v.string(),
    designation: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    url: v.string(),
    priceAmountCents: v.optional(v.number()),
  },
  handler: async (ctx, { issueId, title, designation, subtitle, url, priceAmountCents }) => {
    const issue = await ctx.db.get(issueId);
    // Der Laden fuehrt den Verkaufspreis. Er schlaegt das Impressum — dort
    // steht oft noch der Preis der Vorauflage — und ueberschreibt auch einen
    // alten Ladenstand. Nur was die Redaktion von Hand eingetragen hat, bleibt.
    const preis =
      priceAmountCents &&
      priceAmountCents !== issue?.priceAmountCents &&
      issue?.priceSource !== "redaktion"
        ? {
            priceAmountCents,
            priceSource: "laden" as const,
            // Ein neuer Preis macht den hinterlegten Stripe-Preis ungueltig.
            stripePriceId: undefined,
          }
        : {};
    await ctx.db.patch(issueId, {
      shopTitle: title,
      shopDesignation: designation,
      shopSubtitle: subtitle,
      shopUrl: url,
      shopSyncedAt: Date.now(),
      updatedAt: Date.now(),
      ...preis,
    });
  },
});

/**
 * Das aktuelle Heft einer Reihe im Shop. Nummerierte Reihen sortiert die
 * Kategorie nach Artikelnummer, neueste zuerst; bei ZUERST! greift keine
 * Sortierung, dort findet die Suche nach Jahr die Hefte. Das Bild aus der
 * Startseiten-Leiste entscheidet, welches Heft gemeint ist.
 */
async function findCurrentProduct(series: Series, entry: StripEntry): Promise<ProductCard | null> {
  const pages: string[] = [];
  if (series.numbered) {
    pages.push(categoryUrl(series));
  } else {
    const year = new Date().getFullYear();
    pages.push(searchUrl(`${series.searchPrefix} ${year}`), searchUrl(`${series.searchPrefix} ${year - 1}`));
  }
  let first: ProductCard | null = null;
  for (const url of pages) {
    const html = await getText(url);
    if (!html) continue;
    const cards = parseProductCards(html);
    const byImage = cards.find((c) => c.imageId === entry.imageId);
    if (byImage) return byImage;
    if (series.numbered && !first && cards.length > 0) first = cards[0];
  }
  return first;
}

const MAX_CATEGORY_PAGES = 12;

/**
 * Das Produkt zu einem eigenen Heft. Nummerierte Reihen: die nach
 * Artikelnummer sortierte Kategorie, Seite fuer Seite, bis die Nummer
 * gefunden oder unterschritten ist. ZUERST!: die Suche nach Monat und Jahr,
 * die eindeutig trifft — die Kategorie sortiert dort nicht.
 */
async function findIssueProduct(
  series: Series,
  issueNumber: string,
  pageCache: Map<string, ProductCard[]>,
): Promise<ProductCard | null> {
  const cardsOf = async (url: string): Promise<ProductCard[]> => {
    const cached = pageCache.get(url);
    if (cached) return cached;
    const html = await getText(url);
    const cards = html ? parseProductCards(html) : [];
    pageCache.set(url, cards);
    return cards;
  };
  if (!series.numbered) {
    const query = searchQueryForIssue(series, issueNumber);
    if (!query) return null;
    const cards = await cardsOf(searchUrl(query));
    return cards.find((c) => designationMatches(series, c.designation, issueNumber)) ?? null;
  }
  const wanted = Number(/^(\d+)/.exec(issueNumber.trim())?.[1]);
  if (!wanted) return null;
  for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
    const cards = await cardsOf(categoryUrl(series, page));
    if (cards.length === 0) break;
    const hit = cards.find((c) => designationMatches(series, c.designation, issueNumber));
    if (hit) return hit;
    const numbers = cards
      .map((c) => Number(/(?:Nr\.?|Heft)\s*(\d+)\b/i.exec(c.designation)?.[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (numbers.length > 0 && Math.max(...numbers) < wanted) break;
  }
  return null;
}

/**
 * Titelbilder und Heftbezeichnungen aller Reihen mit dem Verlagsshop
 * abgleichen. Laeuft taeglich (crons.ts) und von der Kommandozeile:
 *
 *     npx convex run publicationCovers:refreshAll
 *
 * Je Reihe: das Titelbild der aktuellen Ausgabe (nur wenn Adresse oder
 * Kennzeichen sich geaendert haben), Name, Heftbezeichnung und
 * Unter-Ueberschrift der aktuellen Ausgabe, und fuer eigene Hefte ohne
 * Zuordnung dieselben Angaben vom passenden Produkt, gefunden ueber die Suche
 * nach der Heftbezeichnung.
 */
/**
 * Denselben Abgleich von Hand anstossen — der Knopf in der Redaktion. Damit
 * steht ein geaenderter Ladenpreis sofort am Heft, ohne auf den naechtlichen
 * Lauf zu warten.
 */
export const refreshNow = action({
  args: {},
  handler: async (ctx): Promise<{ issues: string[]; missing: string[]; failed: string[] }> => {
    await ctx.runQuery(internal.publicationCovers.requireEditorInternal, {});
    const ergebnis = await ctx.runAction(internal.publicationCovers.refreshAll, {});
    return {
      issues: ergebnis.issues,
      missing: ergebnis.missing,
      failed: ergebnis.failed,
    };
  },
});

/** Nur die Rollenpruefung, damit die Aktion sie aufrufen kann. */
export const requireEditorInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireEditor(ctx);
    return true;
  },
});

export const refreshAll = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    updated: string[];
    unchanged: string[];
    missing: string[];
    failed: string[];
    currentIssues: string[];
    issues: string[];
  }> => {
    const homepage = await getText(`${SHOP_URL}/`);
    if (!homepage) throw new Error("Startseite des Shops nicht erreichbar");
    const entries = parseMagazineStrip(homepage);
    const publications: {
      _id: Id<"publications">;
      slug: string;
      coverSource: string | null;
      coverAssetId: Id<"assets"> | null;
      currentIssueUrl: string | null;
    }[] = await ctx.runQuery(internal.publicationCovers.listInternal, {});

    const result = {
      updated: [] as string[],
      unchanged: [] as string[],
      missing: [] as string[],
      failed: [] as string[],
      currentIssues: [] as string[],
      issues: [] as string[],
    };
    const pageCache = new Map<string, ProductCard[]>();
    for (const publication of publications) {
      const series = seriesFor(publication.slug);
      const entry = entries.find((e) => e.slug === publication.slug);
      if (!series || !entry) {
        result.missing.push(publication.slug);
        continue;
      }

      // 1. Titelbild
      try {
        let done = false;
        for (const url of coverCandidates(entry)) {
          const head = await fetch(url, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
          if (!head.ok || !(head.headers.get("content-type") ?? "").startsWith("image/")) continue;
          const mark = head.headers.get("etag") ?? head.headers.get("last-modified") ?? head.headers.get("content-length") ?? "";
          const source = `${url}|${mark}`;
          if (publication.coverAssetId && publication.coverSource === source) {
            result.unchanged.push(publication.slug);
            done = true;
            break;
          }
          const image = await fetch(url, { headers: { "user-agent": USER_AGENT } });
          if (!image.ok) continue;
          const blob = await image.blob();
          if (blob.size < 10_000) continue;
          const storageId = await ctx.storage.store(blob);
          await ctx.runMutation(internal.publicationCovers.setCoverInternal, {
            publicationId: publication._id,
            storageId,
            contentType: blob.type || "image/jpeg",
            bytes: blob.size,
            source,
            label: entry.label,
            imageId: entry.imageId,
          });
          result.updated.push(`${publication.slug}: ${entry.label} (${url})`);
          done = true;
          break;
        }
        if (!done) result.failed.push(`${publication.slug}: Titelbild`);
      } catch (error) {
        console.error(`Titelbild ${publication.slug}`, error);
        result.failed.push(`${publication.slug}: Titelbild`);
      }

      // 2. Aktuelle Ausgabe
      try {
        const product = await findCurrentProduct(series, entry);
        if (product && product.url !== publication.currentIssueUrl) {
          const page = await getText(product.url);
          const parsed = page ? parseProductPage(page) : null;
          await ctx.runMutation(internal.publicationCovers.setCurrentIssueInternal, {
            publicationId: publication._id,
            name: parsed?.name ?? product.name,
            designation: parsed?.designation ?? product.designation ?? undefined,
            subtitle: parsed?.subtitle ?? undefined,
            url: product.url,
          });
          result.currentIssues.push(`${publication.slug}: ${parsed?.name ?? product.name}`);
        }
      } catch (error) {
        console.error(`Aktuelle Ausgabe ${publication.slug}`, error);
        result.failed.push(`${publication.slug}: aktuelle Ausgabe`);
      }

      // 3. Alle eigenen Hefte mit Nummer: Bezeichnung und Preis nachziehen
      const issues: {
        _id: Id<"issues">;
        issueNumber: string;
        title: string;
        shopUrl?: string;
      }[] =
        await ctx.runQuery(internal.publicationCovers.unlabeledIssuesInternal, {
          publicationId: publication._id,
        });
      for (const issue of issues) {
        try {
          const adresse =
            issue.shopUrl ??
            (await findIssueProduct(series, issue.issueNumber, pageCache))?.url;
          if (!adresse) continue;
          const page = await getText(adresse);
          const parsed = page ? parseProductPage(page) : null;
          if (!parsed) continue;
          await ctx.runMutation(internal.publicationCovers.setIssueShopLabelsInternal, {
            issueId: issue._id,
            title: parsed.name,
            designation: parsed.designation ?? undefined,
            subtitle: parsed.subtitle ?? undefined,
            url: adresse,
            priceAmountCents: parsed.priceCents ?? undefined,
          });
          const preis = parsed.priceCents
            ? ` · ${(parsed.priceCents / 100).toFixed(2)} €`
            : "";
          result.issues.push(`${issue.title} → ${parsed.name}${preis}`);
        } catch (error) {
          console.error(`Heft ${issue.title}`, error);
          result.failed.push(`${publication.slug}: ${issue.title}`);
        }
      }
    }
    console.log(JSON.stringify({ event: "shop.refresh", ...result }));
    return result;
  },
});
