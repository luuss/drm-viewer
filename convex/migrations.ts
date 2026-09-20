import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * Einmalige Migration vom Prototyp (`books`, Artikel mit einem Textfeld) auf
 * das Verlagsmodell.
 *
 * Wiederholbar: bereits migrierte Ausgaben werden ueber `slug` erkannt und
 * uebersprungen. Der Lauf protokolliert, was er getan hat.
 *
 * Aufruf: npx convex run migrations:migrateBooksToIssues '{"dryRun":true}'
 */
export const migrateBooksToIssues = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const db = ctx.db as any;
    const report: string[] = [];

    let books: any[] = [];
    try {
      books = await db.query("books").collect();
    } catch {
      return { ok: true, note: "Keine Tabelle books vorhanden, nichts zu tun" };
    }
    if (books.length === 0) {
      return { ok: true, note: "Keine Altdaten gefunden" };
    }

    // Eine Standard-Publikation aufnehmen, damit Ausgaben ein Zuhause haben.
    let publication = await ctx.db
      .query("publications")
      .withIndex("by_slug", (q) => q.eq("slug", "archiv"))
      .first();
    if (!publication && !dryRun) {
      const id = await ctx.db.insert("publications", {
        name: "Archiv",
        slug: "archiv",
        description: "Aus dem Prototyp uebernommene Titel",
        isActive: true,
        createdAt: Date.now(),
      });
      publication = await ctx.db.get(id);
    }
    report.push(`Publikation: ${publication?._id ?? "(dryRun)"}`);

    for (const book of books) {
      const slug = `alt-${book._id}`;
      const exists = await ctx.db
        .query("issues")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (exists) {
        report.push(`${book.title}: bereits migriert`);
        continue;
      }
      if (dryRun) {
        report.push(`${book.title}: wuerde migriert`);
        continue;
      }

      const now = Date.now();
      // Die alte PDF-Datei wird als Quelle und als einzige Seitenquelle uebernommen.
      const assetId = await ctx.db.insert("assets", {
        key: `legacy/${book._id}/${book.filename ?? "datei.pdf"}`,
        contentType: "application/pdf",
        kind: "source",
        convexStorageId: book.pdfStorageId,
        createdAt: now,
      });
      let coverAssetId: Id<"assets"> | undefined;
      if (book.coverStorageId) {
        coverAssetId = await ctx.db.insert("assets", {
          key: `legacy/${book._id}/cover`,
          contentType: "image/jpeg",
          kind: "cover",
          convexStorageId: book.coverStorageId,
          createdAt: now,
        });
      }

      const issueId = await ctx.db.insert("issues", {
        publicationId: publication!._id,
        title: book.title,
        slug,
        issueNumber: book.issueNumber,
        description: book.description,
        coverAssetId,
        pageCount: book.pageCount ?? 0,
        priceAmountCents: book.priceCents ?? 0,
        externalSku: undefined,
        stripePriceId: book.stripePriceId,
        stripeProductId: book.stripeProductId,
        isPublished: Boolean(book.isPublished),
        includedInSubscription: book.includedInSubscription !== false,
        publishedAt: book.publishedAt,
        createdAt: book.createdAt ?? now,
        updatedAt: now,
      });
      await ctx.db.insert("issueSources", {
        issueId,
        kind: "pdf",
        role: "inner",
        assetId,
        filename: book.filename ?? "datei.pdf",
        pageCount: book.pageCount ?? 0,
        sortOrder: 0,
        createdAt: now,
      });
      for (let i = 0; i < (book.pageCount ?? 0); i++) {
        await ctx.db.insert("issuePages", {
          issueId,
          index: i,
          role: "content",
          sourceAssetId: assetId,
          sourcePageIndex: i,
          width: book.pageWidth ?? 0,
          height: book.pageHeight ?? 0,
        });
      }

      // Artikel: Text wird zu Absatzbloecken, boxes werden zu Regionen.
      const oldArticles = await db
        .query("articles")
        .filter((q: any) => q.eq(q.field("bookId"), book._id))
        .collect();
      for (const old of oldArticles) {
        const articleId = await ctx.db.insert("articles", {
          issueId,
          order: old.order ?? 1,
          title: old.title ?? "Ohne Titel",
          subtitle: old.subtitle,
          author: old.author,
          teaser: old.teaser,
          source: old.source === "idml" ? "idml" : "pdf",
          reviewStatus: old.status === "published" ? "approved" : "pending",
          primaryPageIndex: Math.max(0, (old.pageStart ?? 1) - 1),
          pageStart: Math.max(0, (old.pageStart ?? 1) - 1),
          pageEnd: Math.max(0, (old.pageEnd ?? 1) - 1),
          searchText: old.text ?? "",
          createdAt: old.updatedAt ?? now,
          updatedAt: now,
        });
        const paragraphs = String(old.text ?? "")
          .split(/\n{2,}/)
          .map((t: string) => t.trim())
          .filter(Boolean);
        let order = 1;
        for (const text of paragraphs) {
          await ctx.db.insert("articleBlocks", {
            articleId,
            issueId,
            order: order++,
            type: "paragraph",
            text,
          });
        }
        for (const [i, box] of (old.boxes ?? []).entries()) {
          await ctx.db.insert("articleRegions", {
            articleId,
            issueId,
            // Alte Kaesten zaehlten Seiten ab 1, die neue Ordnung ab 0.
            pageIndex: Math.max(0, (box.page ?? 1) - 1),
            x0: box.x0,
            y0: box.y0,
            x1: box.x1,
            y1: box.y1,
            kind: "body",
            order: i,
          });
        }
      }

      // Zugriffe, Kaeufe und Lesestand umhaengen.
      const ents = await db
        .query("entitlements")
        .filter((q: any) => q.eq(q.field("bookId"), book._id))
        .collect();
      for (const e of ents) {
        await ctx.db.patch(e._id, { issueId, bookId: undefined } as any);
      }
      const purchases = await db
        .query("purchases")
        .filter((q: any) => q.eq(q.field("bookId"), book._id))
        .collect();
      for (const p of purchases) {
        await ctx.db.patch(p._id, { issueId, bookId: undefined } as any);
      }
      const progress = await db
        .query("readingProgress")
        .filter((q: any) => q.eq(q.field("bookId"), book._id))
        .collect();
      for (const p of progress) {
        await ctx.db.patch(p._id, {
          issueId,
          bookId: undefined,
          mode: "page",
          pageIndex: Math.max(0, (p.page ?? 1) - 1),
          page: undefined,
        } as any);
      }

      report.push(
        `${book.title}: Ausgabe ${issueId}, ${oldArticles.length} Artikel, ${ents.length} Freischaltungen`,
      );
    }

    console.log(JSON.stringify({ event: "migration.books", report }));
    return { ok: true, dryRun: Boolean(dryRun), report };
  },
});

/** Raeumt die Altbestaende ab, sobald die Migration geprueft ist. */
export const dropLegacyTables = internalMutation({
  args: { confirm: v.literal("LOESCHEN") },
  handler: async (ctx) => {
    const db = ctx.db as any;
    let removed = 0;
    // Alles aus dem alten Modell erkennt man am Feld bookId.
    for (const table of ["claimTokens", "purchases", "entitlements", "readingProgress", "consents", "importJobs", "readerSessions"]) {
      const rows = await db.query(table).collect();
      for (const r of rows) {
        if ((r as any).bookId !== undefined) {
          await ctx.db.delete(r._id);
          removed++;
        }
      }
    }

    const articles = await db.query("articles").collect();
    for (const a of articles) {
      if ((a as any).bookId !== undefined) {
        await ctx.db.delete(a._id);
        removed++;
      }
    }
    // Das alte Waehrungsfeld faellt weg: das MVP fuehrt nur Euro.
    for (const table of ["purchases", "issues", "subscriptionPlans"]) {
      const rows = await db.query(table).collect();
      for (const r of rows) {
        if ((r as any).currency !== undefined) {
          await ctx.db.patch(r._id, { currency: undefined } as any);
        }
        if ((r as any).priceCents !== undefined) {
          await ctx.db.patch(r._id, {
            priceAmountCents: (r as any).priceCents,
            priceCents: undefined,
          } as any);
        }
      }
    }
    for (const table of ["books", "tileSessions"]) {
      try {
        const rows = await db.query(table).collect();
        for (const r of rows) {
          await ctx.db.delete(r._id);
          removed++;
        }
      } catch {
        // Tabelle gibt es nicht mehr.
      }
    }
    return { removed };
  },
});
