import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Doc, Id } from "./_generated/dataModel";
import { hasIssueAccess, normalizeEmail } from "./access";
import { issueShopSku } from "./shopLinks";
import { WITHDRAWAL_WAIVER_TEXT, WITHDRAWAL_WAIVER_VERSION } from "./consents";
import {
  LAENDER,
  MAX_HEFTE,
  adresseV,
  adressePruefen,
  kartenName,
  naechsterVersuchMs,
  stripeKonfig,
} from "./leserStripe";

/**
 * Kartenkauf im Leser: Datenhaltung (Abfragen und Mutationen). Die Aufrufe an
 * Stripe und den Shop stehen in `leserZahlung.ts` (Node), der Webhook in
 * `leserWebhook.ts`.
 *
 * Ablauf: `kaufen` legt einen Kauf an und belastet die Karte. Sobald Stripe
 * die Zahlung bestaetigt (Webhook oder Rueckfrage), steht der Kauf auf
 * `bezahlt` und `bestellungAnlegen` bucht ihn im Shop. Der Shop meldet die
 * bezahlte Bestellung wie jede andere an `/shop/entitlements`; erst das
 * schaltet frei.
 */

const modusV = v.union(v.literal("test"), v.literal("live"));


async function adresseVon(ctx: QueryCtx, userId: Id<"users">) {
  const a = await ctx.db
    .query("leserKunden")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!a) return null;
  return {
    vorname: a.vorname,
    nachname: a.nachname,
    firma: a.firma,
    strasse: a.strasse,
    zusatz: a.zusatz,
    plz: a.plz,
    ort: a.ort,
    land: a.land,
  };
}

async function karteVon(ctx: QueryCtx, userId: Id<"users">, modus: "test" | "live") {
  return await ctx.db
    .query("leserKarten")
    .withIndex("by_user_modus", (q) => q.eq("userId", userId).eq("modus", modus))
    .unique();
}

function karteOeffentlich(k: Doc<"leserKarten"> | null) {
  if (!k || !k.paymentMethodId || !k.marke || !k.letzte4) return null;
  return {
    name: kartenName({ marke: k.marke, letzte4: k.letzte4 }),
    marke: k.marke,
    letzte4: k.letzte4,
    ablauf:
      k.ablaufMonat && k.ablaufJahr
        ? `${String(k.ablaufMonat).padStart(2, "0")}/${String(k.ablaufJahr).slice(-2)}`
        : null,
    wallet: k.wallet ?? null,
  };
}

async function adresseSchreiben(
  ctx: MutationCtx,
  userId: Id<"users">,
  roh: Parameters<typeof adressePruefen>[0],
) {
  const a = adressePruefen(roh);
  const vorhanden = await ctx.db
    .query("leserKunden")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const werte = {
    vorname: a.vorname,
    nachname: a.nachname,
    firma: a.firma,
    strasse: a.strasse,
    zusatz: a.zusatz,
    plz: a.plz,
    ort: a.ort,
    land: a.land,
    updatedAt: Date.now(),
  };
  if (vorhanden) await ctx.db.replace(vorhanden._id, { userId, ...werte });
  else await ctx.db.insert("leserKunden", { userId, ...werte });
  return a;
}

// --- Oberflaeche ------------------------------------------------------------

/** Was die Kasse braucht: an/aus, Modus, Schluessel fuer Stripe.js, Karte, Adresse. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const konfig = stripeKonfig();
    const laender = Object.entries(LAENDER).map(([iso, name]) => ({ iso, name }));
    if (!konfig) {
      return { aktiv: false as const, laender };
    }
    const userId = await getAuthUserId(ctx);
    const karte = userId ? await karteVon(ctx, userId, konfig.modus) : null;
    return {
      aktiv: true as const,
      modus: konfig.modus,
      publishableKey: konfig.publishableKey,
      angemeldet: userId !== null,
      karte: karteOeffentlich(karte),
      adresse: userId ? await adresseVon(ctx, userId) : null,
      laender,
    };
  },
});

export const adresseSpeichern = mutation({
  args: { adresse: adresseV },
  returns: v.null(),
  handler: async (ctx, { adresse }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Nicht angemeldet");
    await adresseSchreiben(ctx, userId, adresse);
    return null;
  },
});

/** Stand eines eigenen Kaufs, fuer die Anzeige nach dem Bezahlen. */
export const kaufStatus = query({
  args: { kaufId: v.id("leserKaeufe") },
  handler: async (ctx, { kaufId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const kauf = await ctx.db.get(kaufId);
    if (!kauf || kauf.userId !== userId) return null;
    let freigeschaltet = kauf.issueIds.length > 0;
    for (const issueId of kauf.issueIds) {
      if (!(await hasIssueAccess(ctx, userId, issueId))) {
        freigeschaltet = false;
        break;
      }
    }
    return {
      status: kauf.status,
      fehler: kauf.fehler ?? null,
      bestellung: kauf.shopReference ?? null,
      betragCents: kauf.betragCents,
      freigeschaltet,
      issueIds: kauf.issueIds,
    };
  },
});

/** Die letzten Kaeufe im Leser fuer das Konto. */
export const meineKaeufe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const kaeufe = await ctx.db
      .query("leserKaeufe")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
    const out = [];
    for (const k of kaeufe) {
      if (k.status === "angelegt" || k.status === "fehlgeschlagen") continue;
      const titel: string[] = [];
      for (const id of k.issueIds) {
        const issue = await ctx.db.get(id);
        if (issue) titel.push(issue.shopTitle ?? issue.title);
      }
      out.push({
        _id: k._id,
        createdAt: k.createdAt,
        titel,
        betragCents: k.betragCents,
        status: k.status,
        bestellung: k.shopReference ?? null,
        test: k.modus === "test",
      });
    }
    return out;
  },
});

// --- Kauf vorbereiten --------------------------------------------------------

/**
 * Alles, was `kaufen` vor dem Belasten braucht, in einem Lesezugriff:
 * Konto, Adresse, Karte und die Hefte mit Artikelnummer im Shop. Hefte, die
 * das Konto schon lesen darf, fallen mit Fehler heraus.
 */
export const kaufVorbereiten = internalQuery({
  args: {
    userId: v.id("users"),
    issueIds: v.array(v.id("issues")),
    modus: modusV,
  },
  handler: async (ctx, { userId, issueIds, modus }) => {
    const user = await ctx.db.get(userId);
    const email = normalizeEmail(user?.email);
    if (!email) throw new Error("Das Konto hat keine E-Mail-Adresse.");
    const ids = [...new Set(issueIds)];
    if (ids.length === 0) throw new Error("Keine Ausgabe ausgewählt.");
    if (ids.length > MAX_HEFTE) throw new Error(`Höchstens ${MAX_HEFTE} Ausgaben je Kauf.`);
    const hefte = [];
    for (const id of ids) {
      const issue = await ctx.db.get(id);
      if (!issue || !issue.isPublished) throw new Error("Eine Ausgabe ist nicht mehr erhältlich.");
      const sku = issueShopSku(issue);
      if (!sku) {
        throw new Error(`„${issue.shopTitle ?? issue.title}“ ist nicht als Digitalausgabe erhältlich.`);
      }
      if (await hasIssueAccess(ctx, userId, id)) {
        throw new Error(`„${issue.shopTitle ?? issue.title}“ gehört schon zu Ihrer Bibliothek.`);
      }
      hefte.push({ issueId: id, titel: issue.shopTitle ?? issue.title, sku });
    }
    const karte = await karteVon(ctx, userId, modus);
    return {
      email,
      adresse: await adresseVon(ctx, userId),
      stripeCustomerId: karte?.stripeCustomerId ?? null,
      paymentMethodId: karte?.paymentMethodId ?? null,
      hefte,
    };
  },
});

export const adresseSetzen = internalMutation({
  args: { userId: v.id("users"), adresse: adresseV },
  returns: v.null(),
  handler: async (ctx, { userId, adresse }) => {
    await adresseSchreiben(ctx, userId, adresse);
    return null;
  },
});

export const kundeMerken = internalMutation({
  args: { userId: v.id("users"), modus: modusV, stripeCustomerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, modus, stripeCustomerId }) => {
    const k = await karteVon(ctx, userId, modus);
    if (k) {
      if (k.stripeCustomerId !== stripeCustomerId) {
        await ctx.db.patch(k._id, {
          stripeCustomerId,
          paymentMethodId: undefined,
          marke: undefined,
          letzte4: undefined,
          ablaufMonat: undefined,
          ablaufJahr: undefined,
          wallet: undefined,
          updatedAt: Date.now(),
        });
      }
      return null;
    }
    await ctx.db.insert("leserKarten", {
      userId,
      modus,
      stripeCustomerId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const kaufAnlegen = internalMutation({
  args: {
    userId: v.id("users"),
    email: v.string(),
    modus: modusV,
    issueIds: v.array(v.id("issues")),
    skus: v.array(v.string()),
    betragCents: v.number(),
    karteGespeichert: v.boolean(),
  },
  returns: v.id("leserKaeufe"),
  handler: async (ctx, args) => {
    const jetzt = Date.now();
    return await ctx.db.insert("leserKaeufe", {
      ...args,
      status: "angelegt",
      versuche: 0,
      createdAt: jetzt,
      updatedAt: jetzt,
    });
  },
});

/**
 * PaymentIntent am Kauf vermerken und den Widerrufsverzicht je Heft belegen
 * (Wortlaut und Version wie im Formular, Zahlung als Beleg).
 */
export const zahlungVermerken = internalMutation({
  args: { kaufId: v.id("leserKaeufe"), paymentIntentId: v.string() },
  returns: v.null(),
  handler: async (ctx, { kaufId, paymentIntentId }) => {
    const kauf = await ctx.db.get(kaufId);
    if (!kauf) throw new Error("Kauf fehlt");
    await ctx.db.patch(kaufId, { paymentIntentId, updatedAt: Date.now() });
    for (const issueId of kauf.issueIds) {
      await ctx.db.insert("consents", {
        userId: kauf.userId,
        email: kauf.email,
        type: "withdrawal_waiver",
        documentVersion: WITHDRAWAL_WAIVER_VERSION,
        text: WITHDRAWAL_WAIVER_TEXT,
        issueId,
        stripeSessionId: paymentIntentId,
        createdAt: Date.now(),
      });
    }
    await ctx.db.insert("auditLog", {
      actorUserId: kauf.userId,
      actorEmail: kauf.email,
      action: "leser.kauf",
      target: paymentIntentId,
      detail: `${kauf.skus.join(",")} ${kauf.betragCents} Cent (${kauf.modus}), Knopf „Jetzt zahlungspflichtig kaufen“`,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const kaufFehlgeschlagen = internalMutation({
  args: {
    kaufId: v.optional(v.id("leserKaeufe")),
    paymentIntentId: v.optional(v.string()),
    fehler: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { kaufId, paymentIntentId, fehler }) => {
    const kauf = kaufId
      ? await ctx.db.get(kaufId)
      : paymentIntentId
        ? await ctx.db
            .query("leserKaeufe")
            .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", paymentIntentId))
            .unique()
        : null;
    if (!kauf || kauf.status !== "angelegt") return null;
    await ctx.db.patch(kauf._id, { status: "fehlgeschlagen", fehler, updatedAt: Date.now() });
    return null;
  },
});

// --- Nach der Zahlung --------------------------------------------------------

export const kaufNachZahlung = internalQuery({
  args: { paymentIntentId: v.string() },
  handler: async (ctx, { paymentIntentId }) => {
    return await ctx.db
      .query("leserKaeufe")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", paymentIntentId))
      .unique();
  },
});

/**
 * Stripe meldet die Zahlung als abgeschlossen (Webhook oder Rueckfrage der
 * Aktion). Idempotent: nur der erste Aufruf plant die Bestellung im Shop.
 */
export const zahlungEingegangen = internalMutation({
  args: {
    paymentIntentId: v.string(),
    betragCents: v.number(),
    modus: modusV,
    paymentMethodId: v.optional(v.string()),
    karteSpeichern: v.boolean(),
  },
  returns: v.object({ neu: v.boolean() }),
  handler: async (ctx, args) => {
    const kauf = await ctx.db
      .query("leserKaeufe")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", args.paymentIntentId))
      .unique();
    if (!kauf) {
      console.warn(JSON.stringify({ event: "leser.zahlung.unbekannt", pi: args.paymentIntentId }));
      return { neu: false };
    }
    if (kauf.status !== "angelegt" && kauf.status !== "fehlgeschlagen") return { neu: false };
    const hinweis =
      args.betragCents !== kauf.betragCents
        ? `Stripe meldet ${args.betragCents} Cent, erwartet ${kauf.betragCents}`
        : undefined;
    await ctx.db.patch(kauf._id, { status: "bezahlt", fehler: hinweis, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.leserZahlung.bestellungAnlegen, { kaufId: kauf._id });
    if (args.karteSpeichern && args.paymentMethodId) {
      await ctx.scheduler.runAfter(0, internal.leserZahlung.karteMerken, {
        userId: kauf.userId,
        modus: kauf.modus,
        paymentMethodId: args.paymentMethodId,
      });
    }
    console.log(JSON.stringify({ event: "leser.zahlung", kauf: kauf._id, betrag: args.betragCents }));
    return { neu: true };
  },
});

export const bestellungDaten = internalQuery({
  args: { kaufId: v.id("leserKaeufe") },
  handler: async (ctx, { kaufId }) => {
    const kauf = await ctx.db.get(kaufId);
    if (!kauf) return null;
    return { kauf, adresse: await adresseVon(ctx, kauf.userId) };
  },
});

/** Ergebnis von `create_order`. Bei Fehlern mit wachsendem Abstand erneut. */
export const bestellungErgebnis = internalMutation({
  args: {
    kaufId: v.id("leserKaeufe"),
    ok: v.boolean(),
    wiederholen: v.boolean(),
    shopOrderId: v.optional(v.number()),
    shopReference: v.optional(v.string()),
    shopState: v.optional(v.number()),
    bezahltImShop: v.optional(v.boolean()),
    fehler: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const kauf = await ctx.db.get(a.kaufId);
    if (!kauf) return null;
    const versuche = kauf.versuche + 1;
    if (a.ok) {
      const sauber = a.bezahltImShop !== false;
      await ctx.db.patch(kauf._id, {
        status: sauber ? "bestellt" : "fehler",
        shopOrderId: a.shopOrderId,
        shopReference: a.shopReference,
        shopState: a.shopState,
        fehler: sauber ? undefined : (a.fehler ?? "Bestellung im Netzladen nicht bezahlt"),
        versuche,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("auditLog", {
        actorUserId: kauf.userId,
        action: sauber ? "leser.bestellt" : "leser.bestellfehler",
        target: kauf.paymentIntentId,
        detail: `Shop-Bestellung ${a.shopReference ?? a.shopOrderId} Status ${a.shopState}${a.fehler ? `: ${a.fehler}` : ""}`,
        createdAt: Date.now(),
      });
      return null;
    }
    const warten = a.wiederholen ? naechsterVersuchMs(kauf.versuche) : null;
    await ctx.db.patch(kauf._id, {
      status: warten === null ? "fehler" : kauf.status,
      fehler: a.fehler,
      versuche,
      updatedAt: Date.now(),
    });
    if (warten !== null) {
      await ctx.scheduler.runAfter(warten, internal.leserZahlung.bestellungAnlegen, {
        kaufId: kauf._id,
      });
    } else {
      await ctx.db.insert("auditLog", {
        actorUserId: kauf.userId,
        action: "leser.bestellfehler",
        target: kauf.paymentIntentId,
        detail: `Bestellung im Shop aufgegeben nach ${versuche} Versuchen: ${a.fehler ?? ""}`,
        createdAt: Date.now(),
      });
    }
    console.error(
      JSON.stringify({ event: "leser.bestellung.fehler", kauf: kauf._id, versuche, fehler: a.fehler }),
    );
    return null;
  },
});

export const karteSetzen = internalMutation({
  args: {
    userId: v.id("users"),
    modus: modusV,
    stripeCustomerId: v.string(),
    paymentMethodId: v.string(),
    marke: v.string(),
    letzte4: v.string(),
    ablaufMonat: v.optional(v.number()),
    ablaufJahr: v.optional(v.number()),
    wallet: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const k = await karteVon(ctx, a.userId, a.modus);
    // Nur die Karte des eigenen Stripe-Kunden uebernehmen.
    if (!k || k.stripeCustomerId !== a.stripeCustomerId) return null;
    await ctx.db.patch(k._id, {
      paymentMethodId: a.paymentMethodId,
      marke: a.marke,
      letzte4: a.letzte4,
      ablaufMonat: a.ablaufMonat,
      ablaufJahr: a.ablaufJahr,
      wallet: a.wallet,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const karteVergessen = internalMutation({
  args: { userId: v.id("users"), modus: modusV },
  returns: v.null(),
  handler: async (ctx, { userId, modus }) => {
    const k = await karteVon(ctx, userId, modus);
    if (!k) return null;
    await ctx.db.patch(k._id, {
      paymentMethodId: undefined,
      marke: undefined,
      letzte4: undefined,
      ablaufMonat: undefined,
      ablaufJahr: undefined,
      wallet: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const karteDaten = internalQuery({
  args: { userId: v.id("users"), modus: modusV },
  handler: async (ctx, { userId, modus }) => await karteVon(ctx, userId, modus),
});

export const erstattetVermerken = internalMutation({
  args: { paymentIntentId: v.string(), shopState: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { paymentIntentId, shopState }) => {
    const kauf = await ctx.db
      .query("leserKaeufe")
      .withIndex("by_payment_intent", (q) => q.eq("paymentIntentId", paymentIntentId))
      .unique();
    if (!kauf) return null;
    await ctx.db.patch(kauf._id, { status: "erstattet", shopState, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Kontoloeschung (account.ts `purgeUser`): Rechnungsadresse und Kartenangaben
 * weg, Kaeufe ohne Personenbezug. Die Stripe-Kunden bleiben bei Stripe
 * (Belege des Shops); die Karte ist dort nur am Kunden gespeichert.
 */
export async function leserDatenLoeschen(ctx: MutationCtx, userId: Id<"users">) {
  for (const a of await ctx.db
    .query("leserKunden")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(10)) {
    await ctx.db.delete(a._id);
  }
  for (const k of await ctx.db
    .query("leserKarten")
    .withIndex("by_user_modus", (q) => q.eq("userId", userId))
    .take(10)) {
    await ctx.db.delete(k._id);
  }
  for (const k of await ctx.db
    .query("leserKaeufe")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(500)) {
    await ctx.db.patch(k._id, { email: "geloescht", updatedAt: Date.now() });
  }
}

/**
 * Testkaeufe (Stripe-Testmodus) wegraeumen, nach einem Probelauf:
 * `npx convex run leserKasse:testkaeufeLoeschen '{}'`. Livekaeufe bleiben.
 */
export const testkaeufeLoeschen = internalMutation({
  args: {},
  returns: v.object({ kaeufe: v.number(), karten: v.number() }),
  handler: async (ctx) => {
    let kaeufe = 0;
    for (const status of ["angelegt", "bezahlt", "bestellt", "fehlgeschlagen", "fehler", "erstattet"] as const) {
      for (const k of await ctx.db
        .query("leserKaeufe")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(500)) {
        if (k.modus !== "test") continue;
        await ctx.db.delete(k._id);
        kaeufe++;
      }
    }
    let karten = 0;
    for (const k of await ctx.db.query("leserKarten").take(1000)) {
      if (k.modus !== "test") continue;
      await ctx.db.delete(k._id);
      karten++;
    }
    return { kaeufe, karten };
  },
});
