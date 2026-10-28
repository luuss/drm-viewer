import { v } from "convex/values";
import {
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireEditor, requirePublisher, audit } from "./roles";
import { hasAccessByEmail } from "./access";
import { assetUrl } from "./assets";
import { appUrl } from "./mail";
import { shopLabels } from "./issues";
import { aboKaeuflich } from "./plans";
import { callShopApi } from "./shopApi";
import { isPlausibleEmail, looksLikeToken, normalizeEmail } from "./magicLinkRules";
import { newToken } from "./magicLink";
import {
  HeftMailDaten,
  heftMail,
  heftThema,
  themenAuswahl,
  versandZeit,
} from "./heftMail";

/**
 * Ankuendigung neuer Hefte per Mail.
 *
 * Wer schon einmal ein Heft gekauft hat (im Laden, auch als Gast, oder im
 * Leser), bekommt eine Mail, sobald ein neues Heft veroeffentlicht ist. Je
 * Reihe abbestellbar (`mailEinstellungen`), ueber den Link in jeder Mail,
 * den Ein-Klick-Kopf `List-Unsubscribe` oder die Kontoseite.
 *
 * Ablauf: `publishIssue` plant beim ersten Veroeffentlichen eine Zeile in
 * `heftAnkuendigungen` ein (`VERZUG_MS` spaeter, nie nachts). `starten`
 * sammelt dann die Adressen in `heftAnkuendigungEmpfaenger`, `senden`
 * verschickt sie in kleinen Stapeln ueber die Shop-API `heft_mail` (der
 * Laden hat das Postfix mit DKIM; der Leser keinen eigenen Mailversand).
 * Zieht die Redaktion das Heft zurueck, haelt der Versand an und geht beim
 * erneuten Veroeffentlichen weiter. Abschalten fuer alle Hefte:
 * `HEFT_ANKUENDIGUNG=aus`.
 */

/** Zeit zwischen Veroeffentlichen und Versand: so laesst sich ein Versehen zuruecknehmen. */
export const VERZUG_MS = 30 * 60 * 1000;
const STAPEL = 10;
const PAUSE_MS = 2000;
/** Nach einem Stapel ohne einen einzigen Erfolg (Laden weg) laenger warten. */
const PAUSE_STOERUNG_MS = 5 * 60 * 1000;
/** Bei einer Stoerung (Laden oder Postfix weg) etwa eine Stunde lang nachfassen. */
const MAX_VERSUCHE = 12;
/** Ohne Lebenszeichen so lange setzt der Aufpasser den Lauf fort. */
const STILL_MS = 10 * 60 * 1000;
/** Empfaengerzeilen fertiger Ankuendigungen werden danach geloescht; die Zaehler bleiben. */
const AUFBEWAHREN_MS = 60 * 24 * 60 * 60 * 1000;

/** Woher Kaeufer kommen. Geschenke und Freischaltungen der Redaktion zaehlen nicht. */
const QUELLEN = ["shopAccess", "entitlements", "leserKaeufe", "claimTokens", "purchases"] as const;
const KAUF_FREISCHALTUNG = new Set(["purchase", "claim", "external_shop", "subscription"]);

const quelle = v.union(
  v.literal("shopAccess"),
  v.literal("entitlements"),
  v.literal("leserKaeufe"),
  v.literal("claimTokens"),
  v.literal("purchases"),
);

// --- Einplanen -------------------------------------------------------------

function abgeschaltet(): boolean {
  return (process.env.HEFT_ANKUENDIGUNG ?? "").trim().toLowerCase() === "aus";
}

async function ankuendigungZu(ctx: QueryCtx, issueId: Id<"issues">) {
  return await ctx.db
    .query("heftAnkuendigungen")
    .withIndex("by_issue", (q) => q.eq("issueId", issueId))
    .first();
}

/** Lauf fuer `geplantFuer` ansetzen; ein frueher angesetzter verfaellt. */
async function ansetzen(
  ctx: MutationCtx,
  a: Doc<"heftAnkuendigungen"> | null,
  issue: Doc<"issues">,
  geplantFuer: number,
) {
  const lauf = (a?.lauf ?? 0) + 1;
  const ankuendigungId = a
    ? a._id
    : await ctx.db.insert("heftAnkuendigungen", {
        issueId: issue._id,
        publicationId: issue.publicationId,
        status: "geplant",
        lauf,
        geplantFuer,
        empfaenger: 0,
        gesendet: 0,
        fehler: 0,
        abgemeldet: 0,
        createdAt: Date.now(),
      });
  if (a) await ctx.db.patch(a._id, { status: "geplant", grund: undefined, lauf, geplantFuer });
  await ctx.scheduler.runAt(geplantFuer, internal.heftAnkuendigung.starten, { ankuendigungId, lauf });
}

/**
 * Aus `publishIssue`: beim ersten Veroeffentlichen eine Ankuendigung
 * einplanen; wurde sie durch Zurueckziehen angehalten, geht sie weiter. Ein
 * altes Heft, das schon einmal draussen war, wird nicht neu angekuendigt.
 */
export async function ankuendigungPlanen(
  ctx: MutationCtx,
  issue: Doc<"issues">,
  ersteVeroeffentlichung: boolean,
) {
  if (abgeschaltet()) return;
  const vorhanden = await ankuendigungZu(ctx, issue._id);
  const geplantFuer = versandZeit(Date.now() + VERZUG_MS);
  if (vorhanden) {
    if (vorhanden.status === "abgebrochen" && vorhanden.grund === "zurueckgezogen") {
      await ansetzen(ctx, vorhanden, issue, geplantFuer);
    }
    return;
  }
  if (ersteVeroeffentlichung) await ansetzen(ctx, null, issue, geplantFuer);
}

/** Aus `setPublished`: ein zurueckgezogenes Heft wird nicht (weiter) angekuendigt. */
export async function ankuendigungAnhalten(ctx: MutationCtx, issueId: Id<"issues">) {
  const a = await ankuendigungZu(ctx, issueId);
  if (!a || a.status === "fertig" || a.status === "abgebrochen") return;
  await ctx.db.patch(a._id, { status: "abgebrochen", grund: "zurueckgezogen", lauf: a.lauf + 1 });
}

// --- Adressen sammeln ------------------------------------------------------

export const starten = internalAction({
  args: { ankuendigungId: v.id("heftAnkuendigungen"), lauf: v.number() },
  handler: async (ctx, { ankuendigungId, lauf }) => {
    const los: boolean = await ctx.runMutation(internal.heftAnkuendigung.sammelnBeginnenInternal, {
      ankuendigungId,
      lauf,
    });
    if (!los) return;
    const alle = new Set<string>();
    for (const q of QUELLEN) {
      let cursor: string | null = null;
      for (;;) {
        const seite: { emails: string[]; cursor: string; fertig: boolean } = await ctx.runQuery(
          internal.heftAnkuendigung.adressenSeiteInternal,
          { quelle: q, cursor },
        );
        for (const e of seite.emails) alle.add(e);
        if (seite.fertig) break;
        cursor = seite.cursor;
      }
    }
    const liste = [...alle];
    for (let i = 0; i < liste.length; i += 200) {
      const weiter: boolean = await ctx.runMutation(internal.heftAnkuendigung.empfaengerEintragenInternal, {
        ankuendigungId,
        lauf,
        emails: liste.slice(i, i + 200),
      });
      if (!weiter) return;
    }
    const senden: boolean = await ctx.runMutation(internal.heftAnkuendigung.sendenBeginnenInternal, {
      ankuendigungId,
      lauf,
    });
    if (senden) {
      await ctx.scheduler.runAfter(0, internal.heftAnkuendigung.senden, { ankuendigungId, lauf });
    }
  },
});

/** Gilt der Lauf noch, und ist das Heft noch draussen? Sonst anhalten. */
async function laufGilt(
  ctx: MutationCtx,
  ankuendigungId: Id<"heftAnkuendigungen">,
  lauf: number,
  status: Doc<"heftAnkuendigungen">["status"][],
): Promise<Doc<"heftAnkuendigungen"> | null> {
  const a = await ctx.db.get(ankuendigungId);
  if (!a || a.lauf !== lauf || !status.includes(a.status)) return null;
  const issue = await ctx.db.get(a.issueId);
  if (!issue?.isPublished) {
    await ctx.db.patch(a._id, { status: "abgebrochen", grund: "zurueckgezogen", lauf: a.lauf + 1 });
    return null;
  }
  return a;
}

export const sammelnBeginnenInternal = internalMutation({
  args: { ankuendigungId: v.id("heftAnkuendigungen"), lauf: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { ankuendigungId, lauf }) => {
    const a = await laufGilt(ctx, ankuendigungId, lauf, ["geplant", "sammelt"]);
    if (!a) return false;
    await ctx.db.patch(a._id, { status: "sammelt", aktivAm: Date.now() });
    return true;
  },
});

/** Eine Seite Adressen aus einer Quelle, klein geschrieben, ohne Widerrufenes. */
export const adressenSeiteInternal = internalQuery({
  args: { quelle, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { quelle, cursor }) => {
    const opts = { numItems: 500, cursor };
    const emails: string[] = [];
    let seite: { continueCursor: string; isDone: boolean };
    switch (quelle) {
      case "shopAccess": {
        const p = await ctx.db.query("shopAccess").paginate(opts);
        for (const r of p.page) if (r.revokedAt === undefined) emails.push(r.email);
        seite = p;
        break;
      }
      case "entitlements": {
        const p = await ctx.db.query("entitlements").paginate(opts);
        const nutzer = new Set<Id<"users">>();
        for (const r of p.page) if (KAUF_FREISCHALTUNG.has(r.source)) nutzer.add(r.userId);
        for (const id of nutzer) {
          const u = await ctx.db.get(id);
          if (u?.email) emails.push(u.email);
        }
        seite = p;
        break;
      }
      case "leserKaeufe": {
        const p = await ctx.db.query("leserKaeufe").paginate(opts);
        for (const r of p.page) if (r.status === "bestellt" && r.modus === "live") emails.push(r.email);
        seite = p;
        break;
      }
      case "claimTokens": {
        const p = await ctx.db.query("claimTokens").paginate(opts);
        for (const r of p.page) emails.push(r.email);
        seite = p;
        break;
      }
      case "purchases": {
        const p = await ctx.db.query("purchases").paginate(opts);
        for (const r of p.page) if (r.status === "paid") emails.push(r.email);
        seite = p;
        break;
      }
      default:
        throw new Error(`Unbekannte Quelle ${quelle}`);
    }
    const sauber = [...new Set(emails.map(normalizeEmail))].filter(isPlausibleEmail);
    return { emails: sauber, cursor: seite.continueCursor, fertig: seite.isDone };
  },
});

async function einstellungenZu(ctx: QueryCtx, email: string) {
  return await ctx.db
    .query("mailEinstellungen")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

function bestellt(
  e: Doc<"mailEinstellungen"> | null,
  publicationId: Id<"publications">,
): boolean {
  if (!e) return true;
  return !e.alleAbbestellt && !(e.abbestellt ?? []).includes(publicationId);
}

export const empfaengerEintragenInternal = internalMutation({
  args: {
    ankuendigungId: v.id("heftAnkuendigungen"),
    lauf: v.number(),
    emails: v.array(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, { ankuendigungId, lauf, emails }) => {
    const a = await laufGilt(ctx, ankuendigungId, lauf, ["sammelt"]);
    if (!a) return false;
    let neu = 0;
    let abgemeldet = 0;
    for (const email of emails) {
      const da = await ctx.db
        .query("heftAnkuendigungEmpfaenger")
        .withIndex("by_ankuendigung_and_email", (q) =>
          q.eq("ankuendigungId", ankuendigungId).eq("email", email),
        )
        .first();
      if (da) continue;
      const will = bestellt(await einstellungenZu(ctx, email), a.publicationId);
      await ctx.db.insert("heftAnkuendigungEmpfaenger", {
        ankuendigungId,
        email,
        status: will ? "offen" : "abgemeldet",
        versuche: 0,
      });
      neu++;
      if (!will) abgemeldet++;
    }
    await ctx.db.patch(a._id, {
      empfaenger: a.empfaenger + neu,
      abgemeldet: a.abgemeldet + abgemeldet,
      aktivAm: Date.now(),
    });
    return true;
  },
});

export const sendenBeginnenInternal = internalMutation({
  args: { ankuendigungId: v.id("heftAnkuendigungen"), lauf: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { ankuendigungId, lauf }) => {
    const a = await laufGilt(ctx, ankuendigungId, lauf, ["sammelt"]);
    if (!a) return false;
    await ctx.db.patch(a._id, { status: "sendet", aktivAm: Date.now() });
    await audit(ctx, "heft.ankuendigung", a.issueId, `${a.empfaenger} Adressen`);
    return true;
  },
});

// --- Senden ----------------------------------------------------------------

/** Alles, was die Mail ueber das Heft braucht; fuer alle Empfaenger gleich. */
async function mailDaten(ctx: QueryCtx, issue: Doc<"issues">): Promise<HeftMailDaten> {
  const publication = await ctx.db.get(issue.publicationId);
  const labels = shopLabels(issue, publication?.name ?? null);
  const plans = publication
    ? await ctx.db
        .query("subscriptionPlans")
        .withIndex("by_publication", (q) => q.eq("publicationId", publication._id))
        .take(50)
    : [];
  const eintraege = await ctx.db
    .query("tocEntries")
    .withIndex("by_issue_order", (q) => q.eq("issueId", issue._id))
    .take(80);
  const kandidaten = [];
  for (const e of eintraege) {
    if (!e.articleId) continue;
    const artikel = await ctx.db.get(e.articleId);
    if (!artikel || artikel.reviewStatus !== "approved") continue;
    kandidaten.push({ titel: e.label, unterzeile: artikel.subtitle ?? null });
  }
  const basis = {
    reiheSlug: publication?.slug ?? null,
    reiheName: publication?.name ?? "Lesen & Schenken",
    heftTitel: labels.displayTitle,
    bezeichnung: labels.designation,
  };
  return {
    appUrl: appUrl(),
    ...basis,
    untertitel: labels.subtitle,
    preisCents: issue.priceAmountCents > 0 ? issue.priceAmountCents : null,
    umschlagUrl: await assetUrl(ctx, issue.coverAssetId),
    heftPfad: `/issue/${encodeURIComponent(issue.slug)}`,
    themen: themenAuswahl(kandidaten, heftThema(basis)),
    aboPfad:
      publication && aboKaeuflich(publication, plans)
        ? `/abo/${encodeURIComponent(publication.slug)}`
        : null,
  };
}

/** Zeile einer Adresse; entsteht mit der ersten Mail an sie oder der ersten Aenderung. */
async function einstellungenAnlegen(ctx: MutationCtx, email: string): Promise<Doc<"mailEinstellungen">> {
  const e = await einstellungenZu(ctx, email);
  if (e) return e;
  const id = await ctx.db.insert("mailEinstellungen", { email, token: newToken(), createdAt: Date.now() });
  return (await ctx.db.get(id))!;
}

/** Schluessel der Abmeldeseite. */
async function schluessel(ctx: MutationCtx, email: string): Promise<string> {
  return (await einstellungenAnlegen(ctx, email)).token;
}

type Stapel =
  | { weiter: false }
  | {
      weiter: true;
      daten: HeftMailDaten;
      reiheSlug: string;
      empfaenger: { id: Id<"heftAnkuendigungEmpfaenger">; email: string; token: string; zugang: boolean }[];
    };

export const stapelHolenInternal = internalMutation({
  args: { ankuendigungId: v.id("heftAnkuendigungen"), lauf: v.number() },
  handler: async (ctx, { ankuendigungId, lauf }): Promise<Stapel> => {
    const a = await laufGilt(ctx, ankuendigungId, lauf, ["sendet"]);
    if (!a) return { weiter: false };
    const offen = await ctx.db
      .query("heftAnkuendigungEmpfaenger")
      .withIndex("by_ankuendigung_and_status", (q) =>
        q.eq("ankuendigungId", ankuendigungId).eq("status", "offen"),
      )
      .take(STAPEL);
    if (offen.length === 0) {
      const laeuft = await ctx.db
        .query("heftAnkuendigungEmpfaenger")
        .withIndex("by_ankuendigung_and_status", (q) =>
          q.eq("ankuendigungId", ankuendigungId).eq("status", "laeuft"),
        )
        .first();
      if (!laeuft) await ctx.db.patch(a._id, { status: "fertig", fertigAm: Date.now() });
      return { weiter: false };
    }
    const issue = (await ctx.db.get(a.issueId))!;
    const jetzt = Date.now();
    const empfaenger = [];
    let abgemeldet = 0;
    for (const r of offen) {
      // Abbestellt, seit die Adresse gesammelt wurde?
      if (!bestellt(await einstellungenZu(ctx, r.email), a.publicationId)) {
        await ctx.db.patch(r._id, { status: "abgemeldet" });
        abgemeldet++;
        continue;
      }
      await ctx.db.patch(r._id, { status: "laeuft", vergebenAm: jetzt, versuche: r.versuche + 1 });
      empfaenger.push({
        id: r._id,
        email: r.email,
        token: await schluessel(ctx, r.email),
        zugang: await hasAccessByEmail(ctx, r.email, issue._id),
      });
    }
    await ctx.db.patch(a._id, { abgemeldet: a.abgemeldet + abgemeldet, aktivAm: jetzt });
    const daten = await mailDaten(ctx, issue);
    return { weiter: true, daten, reiheSlug: daten.reiheSlug ?? "", empfaenger };
  },
});

/** Adressen der Abmeldeseite und des Ein-Klick-Abmeldens fuer eine Mail. */
export function abmeldeAdressen(basis: string, token: string, reiheSlug: string) {
  const t = encodeURIComponent(token);
  const r = encodeURIComponent(reiheSlug || "alle");
  return {
    abmeldenUrl: `${basis}/abbestellen?t=${t}&r=${r}`,
    einstellungenUrl: `${basis}/abbestellen?t=${t}`,
    einKlickUrl: `${basis}/hooks/mail/abbestellen?t=${t}&r=${r}`,
  };
}

/** Eine Mail ueber den Laden; wirft wie `callShopApi`. */
async function verschicken(
  daten: HeftMailDaten,
  reiheSlug: string,
  an: { email: string; token: string; zugang: boolean },
) {
  const adressen = abmeldeAdressen(daten.appUrl, an.token, reiheSlug);
  const inhalt = heftMail(daten, { zugang: an.zugang, ...adressen });
  await callShopApi("heft_mail", {
    to: an.email,
    subject: inhalt.betreff,
    html: inhalt.html,
    text: inhalt.text,
    from_name: `${daten.reiheName} · Lesen & Schenken`,
    unsubscribe: adressen.einKlickUrl,
  });
}

export const senden = internalAction({
  args: { ankuendigungId: v.id("heftAnkuendigungen"), lauf: v.number() },
  handler: async (ctx, { ankuendigungId, lauf }) => {
    const stapel: Stapel = await ctx.runMutation(internal.heftAnkuendigung.stapelHolenInternal, {
      ankuendigungId,
      lauf,
    });
    if (!stapel.weiter) return;
    let erfolge = 0;
    const fehlschlaege: { id: Id<"heftAnkuendigungEmpfaenger">; fehler: string; endgueltig: boolean }[] = [];
    for (const an of stapel.empfaenger) {
      try {
        await verschicken(stapel.daten, stapel.reiheSlug, an);
      } catch (err: any) {
        // Endgueltig, wenn es an der Adresse liegt: ungueltig oder schon zu
        // viele Mails bekommen. Alles andere (Laden nicht erreichbar, 502,
        // Modul ohne `heft_mail`) ist eine Stoerung: spaeter noch einmal.
        fehlschlaege.push({
          id: an.id,
          fehler: String(err?.message ?? err).slice(0, 300),
          endgueltig: err?.code === "bad_email" || err?.code === "rate_limited",
        });
        continue;
      }
      erfolge++;
      await ctx.runMutation(internal.heftAnkuendigung.ergebnisInternal, { empfaengerId: an.id, ergebnis: "gesendet" });
    }
    for (const f of fehlschlaege) {
      await ctx.runMutation(internal.heftAnkuendigung.ergebnisInternal, {
        empfaengerId: f.id,
        ergebnis: f.endgueltig ? "fehler" : "nochmal",
        fehler: f.fehler,
      });
    }
    const stoerung = fehlschlaege.some((f) => !f.endgueltig);
    if (stoerung) console.error(JSON.stringify({ event: "heft.ankuendigung.stoerung", fehler: fehlschlaege[0]?.fehler }));
    const pause = stoerung && erfolge === 0 ? PAUSE_STOERUNG_MS : PAUSE_MS;
    await ctx.scheduler.runAfter(pause, internal.heftAnkuendigung.senden, { ankuendigungId, lauf });
  },
});

export const ergebnisInternal = internalMutation({
  args: {
    empfaengerId: v.id("heftAnkuendigungEmpfaenger"),
    ergebnis: v.union(v.literal("gesendet"), v.literal("nochmal"), v.literal("fehler")),
    fehler: v.optional(v.string()),
  },
  handler: async (ctx, { empfaengerId, ergebnis, fehler }) => {
    const r = await ctx.db.get(empfaengerId);
    if (!r || r.status !== "laeuft") return;
    const a = (await ctx.db.get(r.ankuendigungId))!;
    if (ergebnis === "gesendet") {
      await ctx.db.patch(r._id, { status: "gesendet", gesendetAm: Date.now(), fehler: undefined });
      await ctx.db.patch(a._id, { gesendet: a.gesendet + 1, aktivAm: Date.now() });
      return;
    }
    if (ergebnis === "nochmal" && r.versuche < MAX_VERSUCHE) {
      await ctx.db.patch(r._id, { status: "offen", fehler });
      return;
    }
    await ctx.db.patch(r._id, { status: "fehler", fehler });
    await ctx.db.patch(a._id, { fehler: a.fehler + 1, aktivAm: Date.now() });
    console.error(JSON.stringify({ event: "heft.ankuendigung.fehler", ankuendigung: a._id, fehler }));
  },
});

/**
 * Aufpasser (Cron): faellige Ankuendigungen, die nicht angelaufen sind,
 * starten; stehengebliebene Laeufe fortsetzen; alte Empfaengerzeilen
 * loeschen. Eine Adresse, deren Mail bei einem Absturz unterwegs war, gilt
 * als Fehler statt sie zu wiederholen: lieber eine Werbemail zu wenig als
 * eine doppelt.
 */
export const aufpassenInternal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const jetzt = Date.now();
    for (const status of ["geplant", "sammelt", "sendet"] as const) {
      const zeilen = await ctx.db
        .query("heftAnkuendigungen")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(50);
      for (const a of zeilen) {
        if (status === "geplant") {
          if (a.geplantFuer > jetzt - STILL_MS) continue;
          await ctx.scheduler.runAfter(0, internal.heftAnkuendigung.starten, { ankuendigungId: a._id, lauf: a.lauf });
          continue;
        }
        if ((a.aktivAm ?? 0) > jetzt - STILL_MS) continue;
        const lauf = a.lauf + 1;
        let fehler = 0;
        if (status === "sendet") {
          const haengend = await ctx.db
            .query("heftAnkuendigungEmpfaenger")
            .withIndex("by_ankuendigung_and_status", (q) => q.eq("ankuendigungId", a._id).eq("status", "laeuft"))
            .take(STAPEL * 2);
          for (const r of haengend) {
            await ctx.db.patch(r._id, { status: "fehler", fehler: "Versand unterbrochen" });
            fehler++;
          }
        }
        await ctx.db.patch(a._id, { lauf, aktivAm: jetzt, fehler: a.fehler + fehler });
        await ctx.scheduler.runAfter(
          0,
          status === "sendet" ? internal.heftAnkuendigung.senden : internal.heftAnkuendigung.starten,
          { ankuendigungId: a._id, lauf },
        );
      }
    }

    const fertige = await ctx.db
      .query("heftAnkuendigungen")
      .withIndex("by_status", (q) => q.eq("status", "fertig"))
      .take(50);
    for (const a of fertige) {
      if ((a.fertigAm ?? jetzt) > jetzt - AUFBEWAHREN_MS) continue;
      for (const status of ["gesendet", "fehler", "abgemeldet", "offen"] as const) {
        const alt = await ctx.db
          .query("heftAnkuendigungEmpfaenger")
          .withIndex("by_ankuendigung_and_status", (q) => q.eq("ankuendigungId", a._id).eq("status", status))
          .take(500);
        for (const r of alt) await ctx.db.delete(r._id);
      }
    }
  },
});

// --- Redaktion -------------------------------------------------------------

export const fuerRedaktion = query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requireEditor(ctx);
    const a = await ankuendigungZu(ctx, issueId);
    return {
      abgeschaltet: abgeschaltet(),
      ankuendigung: a
        ? {
            status: a.status,
            grund: a.grund ?? null,
            geplantFuer: a.geplantFuer,
            empfaenger: a.empfaenger,
            gesendet: a.gesendet,
            fehler: a.fehler,
            abgemeldet: a.abgemeldet,
            fertigAm: a.fertigAm ?? null,
          }
        : null,
    };
  },
});

/** Geplante oder laufende Ankuendigung anhalten. */
export const stoppen = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requirePublisher(ctx);
    const a = await ankuendigungZu(ctx, issueId);
    if (!a || a.status === "fertig" || a.status === "abgebrochen") return;
    await ctx.db.patch(a._id, { status: "abgebrochen", grund: "gestoppt", lauf: a.lauf + 1 });
    await audit(ctx, "heft.ankuendigung.stopp", issueId);
  },
});

/**
 * Sofort senden: eine geplante Ankuendigung vorziehen, eine angehaltene
 * fortsetzen oder ein schon veroeffentlichtes Heft nachtraeglich ankuendigen.
 * Wer die Mail schon hat, bekommt sie nicht noch einmal.
 */
export const jetztSenden = mutation({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }) => {
    await requirePublisher(ctx);
    if (abgeschaltet()) throw new Error("Die Ankündigung per Mail ist abgeschaltet (HEFT_ANKUENDIGUNG).");
    const issue = await ctx.db.get(issueId);
    if (!issue?.isPublished) throw new Error("Nur veröffentlichte Hefte lassen sich ankündigen.");
    const a = await ankuendigungZu(ctx, issueId);
    if (a && a.status !== "geplant" && a.status !== "abgebrochen") return;
    await ansetzen(ctx, a, issue, Date.now());
    await audit(ctx, "heft.ankuendigung.jetzt", issueId);
  },
});

export const probeVorbereitenInternal = internalMutation({
  args: { issueId: v.id("issues"), email: v.string() },
  handler: async (ctx, { issueId, email }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue) throw new Error("Ausgabe nicht gefunden");
    const daten = await mailDaten(ctx, issue);
    return {
      daten,
      reiheSlug: daten.reiheSlug ?? "",
      token: await schluessel(ctx, email),
      zugang: await hasAccessByEmail(ctx, email, issueId),
    };
  },
});

/** Probe an die eigene Adresse, genau wie die Kaeufer sie bekommen. */
export const probe = action({
  args: { issueId: v.id("issues") },
  handler: async (ctx, { issueId }): Promise<{ an: string }> => {
    await ctx.runQuery(api.users.requireRoleQuery, { role: "editor" });
    const me: any = await ctx.runQuery(api.users.me, {});
    const email = normalizeEmail(me?.email);
    if (!isPlausibleEmail(email)) throw new Error("Ihr Konto hat keine Mailadresse.");
    const p: { daten: HeftMailDaten; reiheSlug: string; token: string; zugang: boolean } =
      await ctx.runMutation(internal.heftAnkuendigung.probeVorbereitenInternal, { issueId, email });
    await verschicken(p.daten, p.reiheSlug, { email, token: p.token, zugang: p.zugang });
    return { an: email };
  },
});

// --- Abbestellen -----------------------------------------------------------

/** Reihen, zu denen es Mails gibt: aktiv und mit mindestens einem Heft draussen. */
async function mailReihen(ctx: QueryCtx) {
  const hefte = await ctx.db
    .query("issues")
    .withIndex("by_published", (q) => q.eq("isPublished", true))
    .take(2000);
  const ids = [...new Set(hefte.map((i) => i.publicationId))];
  const reihen = [];
  for (const id of ids) {
    const p = await ctx.db.get(id);
    if (p?.isActive) reihen.push(p);
  }
  return reihen.sort((x, y) => x.createdAt - y.createdAt);
}

async function einstellungenZeigen(ctx: QueryCtx, e: Doc<"mailEinstellungen"> | null) {
  return {
    alleAbbestellt: !!e?.alleAbbestellt,
    reihen: (await mailReihen(ctx)).map((p) => ({
      _id: p._id,
      name: p.name,
      slug: p.slug,
      erhalten: bestellt(e, p._id),
    })),
  };
}

/** "kunde@example.de" → "k•••@example.de": die Seite verraet die Adresse nicht ganz. */
function verdeckt(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}•••@${domain ?? ""}`;
}

/**
 * Eine Reihe (oder ohne `publicationId` alle) bestellen oder abbestellen.
 * Wer nach "alle abbestellen" eine Reihe wieder will, bekommt genau diese.
 */
async function einstellen(
  ctx: MutationCtx,
  email: string,
  publicationId: Id<"publications"> | undefined,
  erhalten: boolean,
) {
  const e = await einstellungenAnlegen(ctx, email);
  const jetzt = Date.now();
  if (!publicationId) {
    await ctx.db.patch(e._id, { alleAbbestellt: !erhalten, abbestellt: [], geaendertAm: jetzt });
    return;
  }
  let abbestellt = e.abbestellt ?? [];
  if (e.alleAbbestellt) abbestellt = (await mailReihen(ctx)).map((p) => p._id);
  abbestellt = abbestellt.filter((id) => id !== publicationId);
  if (!erhalten) abbestellt.push(publicationId);
  await ctx.db.patch(e._id, { alleAbbestellt: false, abbestellt, geaendertAm: jetzt });
}

async function zuSchluessel(ctx: QueryCtx, token: string) {
  if (!looksLikeToken(token)) return null;
  return await ctx.db
    .query("mailEinstellungen")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();
}

/** Abmeldeseite: was die Adresse hinter dem Schluessel bekommt. */
export const einstellungenMitSchluessel = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const e = await zuSchluessel(ctx, token);
    if (!e) return null;
    return { adresse: verdeckt(e.email), ...(await einstellungenZeigen(ctx, e)) };
  },
});

export const einstellenMitSchluessel = mutation({
  args: { token: v.string(), publicationId: v.optional(v.id("publications")), erhalten: v.boolean() },
  handler: async (ctx, { token, publicationId, erhalten }) => {
    const e = await zuSchluessel(ctx, token);
    if (!e) throw new Error("Dieser Link ist nicht mehr gültig.");
    await einstellen(ctx, e.email, publicationId, erhalten);
  },
});

async function meineAdresse(ctx: QueryCtx): Promise<string | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const email = normalizeEmail((await ctx.db.get(userId))?.email);
  return isPlausibleEmail(email) ? email : null;
}

/** Kontoseite: dasselbe fuer die Adresse des angemeldeten Kontos. */
export const meineEinstellungen = query({
  args: {},
  handler: async (ctx) => {
    const email = await meineAdresse(ctx);
    if (!email) return null;
    return await einstellungenZeigen(ctx, await einstellungenZu(ctx, email));
  },
});

export const meineEinstellen = mutation({
  args: { publicationId: v.optional(v.id("publications")), erhalten: v.boolean() },
  handler: async (ctx, { publicationId, erhalten }) => {
    const email = await meineAdresse(ctx);
    if (!email) throw new Error("Nicht angemeldet");
    await einstellen(ctx, email, publicationId, erhalten);
  },
});

/** Kontoloeschung: wer sein Konto loescht, bekommt auch keine Werbung mehr. */
export async function alleAbbestellen(ctx: MutationCtx, email: string) {
  const sauber = normalizeEmail(email);
  if (isPlausibleEmail(sauber)) await einstellen(ctx, sauber, undefined, false);
}

export const einKlickInternal = internalMutation({
  args: { token: v.string(), reihe: v.string() },
  handler: async (ctx, { token, reihe }) => {
    const e = await zuSchluessel(ctx, token);
    if (!e) return false;
    const publication =
      reihe && reihe !== "alle"
        ? await ctx.db
            .query("publications")
            .withIndex("by_slug", (q) => q.eq("slug", reihe))
            .first()
        : null;
    await einstellen(ctx, e.email, publication?._id, false);
    return true;
  },
});

/**
 * `POST /mail/abbestellen?t=…&r=<reihe>` (von aussen `/hooks/…`): Ein-Klick-
 * Abmelden aus dem Mailprogramm (RFC 8058, Kopf `List-Unsubscribe-Post`).
 * Ein GET kommt auch von Linkpruefern; er fuehrt nur auf die Abmeldeseite.
 */
export const einKlickHttp = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  const reihe = url.searchParams.get("r") ?? "alle";
  if (request.method !== "POST") {
    const ziel = `${appUrl()}/abbestellen?t=${encodeURIComponent(token)}&r=${encodeURIComponent(reihe)}`;
    return new Response(null, { status: 303, headers: { location: ziel } });
  }
  const ok: boolean = await ctx.runMutation(internal.heftAnkuendigung.einKlickInternal, { token, reihe });
  return new Response(ok ? "abbestellt" : "unbekannt", {
    status: ok ? 200 : 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
});
