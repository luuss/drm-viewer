/**
 * Umsatz und Kaeufer (Seite "Umsatz", Rolle `umsatz`, 03.11.2026).
 *
 * Drei Quellen:
 * * `leserKaeufe`: Kauf im Leser mit Karte. Betrag genau (Stripe).
 * * `purchases`: aelterer Stripe-Checkout. Betrag genau.
 * * `shopAccess`: Freischaltung aus dem Laden je Bestellposition. Der Betrag
 *   steht nur im Laden; hier geschaetzt aus dem Einzelpreis des Hefts und als
 *   Schaetzung gekennzeichnet. Abo-Positionen ohne Betrag.
 *
 * Testkaeufe (`modus: "test"`) zaehlen getrennt und nie zum Umsatz.
 *
 * Die Uebersicht liest die Kauf-Tabellen ganz: sie sind klein (eine Zeile je
 * Kauf), und nur Konten mit der Rolle `umsatz` rufen sie auf. Waechst das in
 * die Zehntausende, nach Monat indexieren.
 */
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireRole } from "./roles";

const BEZAHLT = new Set(["bezahlt", "bestellt"]);

function monat(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "peggy.meisriemel@…" -> "pe…@lesenundschenken.de": genug zum Wiedererkennen. */
export function adresseKurz(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "…";
  return `${name.slice(0, 2)}…@${domain}`;
}

/** Wer ein Heft gekauft hat oder es per Abo/Laden freigeschaltet bekam. */
export async function kaeuferDesHefts(
  ctx: QueryCtx,
  issueId: Id<"issues">,
): Promise<{ konten: number; ladenPositionen: number; leserKaeufe: number }> {
  const rechte = await ctx.db
    .query("entitlements")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const konten = new Set(
    rechte
      .filter((e) => e.source === "purchase" || e.source === "external_shop" || e.source === "subscription")
      .map((e) => e.userId),
  ).size;
  const laden = await ctx.db
    .query("shopAccess")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .collect();
  const ladenPositionen = laden.filter((a) => !a.revokedAt).length;
  const leser = await ctx.db.query("leserKaeufe").collect();
  const leserKaeufe = leser.filter(
    (k) => k.modus === "live" && BEZAHLT.has(k.status) && k.issueIds.includes(issueId),
  ).length;
  return { konten, ladenPositionen, leserKaeufe };
}

export const uebersicht = query({
  args: { jahr: v.optional(v.number()) },
  handler: async (ctx, { jahr }) => {
    await requireRole(ctx, "umsatz");
    const hefte = new Map<string, Doc<"issues">>();
    for (const i of await ctx.db.query("issues").collect()) hefte.set(i._id, i);
    const reihen = new Map<string, string>();
    for (const p of await ctx.db.query("publications").collect()) reihen.set(p._id, p.name);
    const imJahr = (ms: number) => !jahr || new Date(ms).getUTCFullYear() === jahr;

    type Heft = {
      issueId: string;
      titel: string;
      reihe: string;
      leserCents: number;
      leserKaeufe: number;
      ladenPositionen: number;
      ladenSchaetzungCents: number;
      kaeufer: Set<string>;
    };
    const jeHeft = new Map<string, Heft>();
    const heft = (id: string): Heft => {
      let h = jeHeft.get(id);
      if (!h) {
        const i = hefte.get(id);
        h = {
          issueId: id,
          titel: i?.title ?? "(geloescht)",
          reihe: (i && reihen.get(i.publicationId)) ?? "",
          leserCents: 0,
          leserKaeufe: 0,
          ladenPositionen: 0,
          ladenSchaetzungCents: 0,
          kaeufer: new Set(),
        };
        jeHeft.set(id, h);
      }
      return h;
    };
    const jeMonat = new Map<string, { leserCents: number; leserKaeufe: number; ladenPositionen: number; ladenSchaetzungCents: number; erstattetCents: number }>();
    const mon = (m: string) => {
      let x = jeMonat.get(m);
      if (!x) {
        x = { leserCents: 0, leserKaeufe: 0, ladenPositionen: 0, ladenSchaetzungCents: 0, erstattetCents: 0 };
        jeMonat.set(m, x);
      }
      return x;
    };
    const letzte: {
      zeit: number;
      quelle: "Leser" | "Laden" | "Checkout";
      betragCents: number | null;
      geschaetzt: boolean;
      hefte: string[];
      kaeufer: string;
      status: string;
    }[] = [];
    let testCents = 0;
    let testKaeufe = 0;

    // 1. Kaeufe im Leser
    for (const k of await ctx.db.query("leserKaeufe").collect()) {
      if (!imJahr(k.createdAt)) continue;
      if (k.modus !== "live") {
        if (BEZAHLT.has(k.status)) {
          testCents += k.betragCents;
          testKaeufe++;
        }
        continue;
      }
      const m = mon(monat(k.createdAt));
      if (k.status === "erstattet") m.erstattetCents += k.betragCents;
      if (!BEZAHLT.has(k.status)) continue;
      m.leserCents += k.betragCents;
      m.leserKaeufe++;
      // Ein Kauf ueber mehrere Hefte: Betrag zu gleichen Teilen.
      const teil = k.issueIds.length ? Math.round(k.betragCents / k.issueIds.length) : 0;
      for (const id of k.issueIds) {
        const h = heft(id);
        h.leserCents += teil;
        h.leserKaeufe++;
        h.kaeufer.add(k.email.toLowerCase());
      }
      letzte.push({
        zeit: k.createdAt,
        quelle: "Leser",
        betragCents: k.betragCents,
        geschaetzt: false,
        hefte: k.issueIds.map((id) => hefte.get(id)?.title ?? "(geloescht)"),
        kaeufer: adresseKurz(k.email),
        status: k.status,
      });
    }

    // 2. Aelterer Stripe-Checkout
    for (const p of await ctx.db.query("purchases").collect()) {
      if (!imJahr(p.createdAt) || p.status !== "paid") continue;
      const m = mon(monat(p.createdAt));
      m.leserCents += p.amountCents;
      m.leserKaeufe++;
      if (p.issueId) {
        const h = heft(p.issueId);
        h.leserCents += p.amountCents;
        h.leserKaeufe++;
        h.kaeufer.add(p.email.toLowerCase());
      }
      letzte.push({
        zeit: p.createdAt,
        quelle: "Checkout",
        betragCents: p.amountCents,
        geschaetzt: false,
        hefte: p.issueId ? [hefte.get(p.issueId)?.title ?? "(geloescht)"] : ["Abo"],
        kaeufer: adresseKurz(p.email),
        status: p.status,
      });
    }

    // 3. Laden: Freischaltungen je Position, Betrag geschaetzt
    for (const a of await ctx.db.query("shopAccess").collect()) {
      if (!imJahr(a.createdAt) || a.revokedAt) continue;
      const m = mon(monat(a.createdAt));
      m.ladenPositionen++;
      const preis = a.kind === "issue" && a.issueId ? hefte.get(a.issueId)?.priceAmountCents ?? 0 : 0;
      m.ladenSchaetzungCents += preis;
      if (a.issueId) {
        const h = heft(a.issueId);
        h.ladenPositionen++;
        h.ladenSchaetzungCents += preis;
        h.kaeufer.add(a.email.toLowerCase());
      }
      letzte.push({
        zeit: a.createdAt,
        quelle: "Laden",
        betragCents: a.kind === "issue" ? preis : null,
        geschaetzt: true,
        hefte: a.issueId
          ? [hefte.get(a.issueId)?.title ?? "(geloescht)"]
          : [`Abo ${(a.publicationId && reihen.get(a.publicationId)) ?? a.sku}`],
        kaeufer: adresseKurz(a.email),
        status: a.kind === "subscription" ? `Abo ${a.months ?? ""} Monate`.trim() : "Heft",
      });
    }

    const abos = (await ctx.db.query("subscriptions").collect()).filter(
      (s) => s.stripeModus !== "test" && (s.status === "active" || s.status === "trialing"),
    ).length;
    const ladenAbos = (await ctx.db.query("shopAccess").collect()).filter(
      (a) => a.kind === "subscription" && !a.revokedAt && (a.validUntil ?? 0) > Date.now(),
    ).length;

    const monate = [...jeMonat.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([m, x]) => ({ monat: m, ...x }));
    const summe = monate.reduce(
      (s, m) => ({
        leserCents: s.leserCents + m.leserCents,
        leserKaeufe: s.leserKaeufe + m.leserKaeufe,
        ladenPositionen: s.ladenPositionen + m.ladenPositionen,
        ladenSchaetzungCents: s.ladenSchaetzungCents + m.ladenSchaetzungCents,
        erstattetCents: s.erstattetCents + m.erstattetCents,
      }),
      { leserCents: 0, leserKaeufe: 0, ladenPositionen: 0, ladenSchaetzungCents: 0, erstattetCents: 0 },
    );
    return {
      jahr: jahr ?? null,
      summe,
      test: { cents: testCents, kaeufe: testKaeufe },
      abos: { leser: abos, laden: ladenAbos },
      monate,
      hefte: [...jeHeft.values()]
        .map(({ kaeufer, ...h }) => ({ ...h, kaeufer: kaeufer.size }))
        .sort((a, b) => b.leserCents + b.ladenSchaetzungCents - (a.leserCents + a.ladenSchaetzungCents)),
      letzte: letzte.sort((a, b) => b.zeit - a.zeit).slice(0, 50),
    };
  },
});

/** Kaeufer eines Hefts, fuer die Rueckfrage vor dem Loeschen. */
export const kaeuferVonHeft = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireRole(ctx, "editor");
    return await kaeuferDesHefts(ctx, issueId);
  },
});
