import { v } from "convex/values";
import { action, internalAction, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { callShopApi, ShopApiError } from "./shopApi";
import { StripeAufruf, StripeFehler, stripeClient } from "./stripeRest";
import {
  StripeKonfig,
  StripeModus,
  adresseFuerShop,
  adresseV,
  kartenFehler,
  kaufBeschreibung,
  kaufMetadaten,
  secretKeyFuer,
  stripeKonfig,
} from "./leserStripe";

/**
 * Kartenkauf im Leser: Aufrufe an Stripe und an die Shop-API. Datenhaltung
 * in `leserKasse.ts`, Webhook in `leserWebhook.ts`, Vertrag in
 * docs/shop-integration.md („Kartenkauf im Leser“).
 *
 * Bewusst ohne `"use node"` und ohne Stripe-SDK (stripeRest.ts): Node-
 * Aktionen erreichen auf dem Verlagsserver das Backend nicht.
 */

function konfigOderFehler(): StripeKonfig {
  const k = stripeKonfig();
  if (!k) throw new Error("Die Kartenzahlung ist im Leser nicht eingerichtet.");
  return k;
}

function stripeFuer(key: string): StripeAufruf {
  return stripeClient(key);
}

async function angemeldet(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Bitte zuerst anmelden.");
  return userId as Id<"users">;
}

type Angebot = {
  betragCents: number;
  steuerCents: number;
  land: string;
  positionen: { issueId: Id<"issues">; titel: string; sku: string; preisCents: number; steuersatz: number | null }[];
};

async function angebotHolen(
  hefte: { issueId: Id<"issues">; titel: string; sku: string }[],
  land: string,
): Promise<Angebot> {
  let json: Record<string, any>;
  try {
    json = await callShopApi("quote", { skus: hefte.map((h) => h.sku), country_iso: land });
  } catch (e) {
    console.error(JSON.stringify({ event: "leser.angebot.fehler", fehler: String((e as Error).message) }));
    throw new Error("Der Preis ließ sich im Shop gerade nicht abfragen. Bitte gleich noch einmal versuchen.");
  }
  const zeilen: any[] = Array.isArray(json.items) ? json.items : [];
  const betragCents = Number(json.total_cents);
  if (!Number.isInteger(betragCents) || betragCents <= 0) {
    throw new Error("Der Shop lieferte keinen gültigen Preis.");
  }
  return {
    betragCents,
    steuerCents: Number(json.tax_cents) || 0,
    land: String(json.country_iso ?? land),
    positionen: hefte.map((h) => {
      const z = zeilen.find((x) => x?.sku === h.sku);
      return {
        ...h,
        preisCents: Number(z?.price_cents) || 0,
        steuersatz: typeof z?.tax_rate === "number" ? z.tax_rate : null,
      };
    }),
  };
}

/** Preis aus dem Shop fuer die Auswahl, bevor der Kunde zahlt. */
export const angebot = action({
  args: { issueIds: v.array(v.id("issues")), land: v.optional(v.string()) },
  handler: async (ctx, { issueIds, land }): Promise<Angebot> => {
    const konfig = konfigOderFehler();
    const userId = await angemeldet(ctx);
    const vorbereitet = await ctx.runQuery(internal.leserKasse.kaufVorbereiten, {
      userId,
      issueIds,
      modus: konfig.modus,
    });
    return await angebotHolen(vorbereitet.hefte, (land ?? vorbereitet.adresse?.land ?? "DE").toUpperCase());
  },
});

async function stripeKunde(
  ctx: ActionCtx,
  stripe: StripeAufruf,
  konfig: StripeKonfig,
  userId: Id<"users">,
  email: string,
  vorhanden: string | null,
  name: string,
): Promise<string> {
  if (vorhanden) return vorhanden;
  const kunde = await stripe(
    "POST",
    "customers",
    { email, name, metadata: { source: "leser", leserUserId: userId } },
    `leser-kunde-${userId}-${konfig.modus}`,
  );
  await ctx.runMutation(internal.leserKasse.kundeMerken, {
    userId,
    modus: konfig.modus,
    stripeCustomerId: kunde.id,
  });
  return kunde.id;
}

/**
 * Kaufen. `zahlweise: "gespeichert"` belastet die gespeicherte Karte sofort
 * (on-session); verlangt die Bank eine Bestaetigung, kommt `aktion` mit dem
 * Client-Geheimnis fuer `stripe.handleNextAction`. `zahlweise: "neu"` legt nur
 * den PaymentIntent an; bestaetigt wird im Browser mit dem Payment Element.
 * Danach ruft die Oberflaeche `kaufPruefen`.
 */
export const kaufen = action({
  args: {
    issueIds: v.array(v.id("issues")),
    erwarteterBetragCents: v.number(),
    widerrufsverzicht: v.boolean(),
    zahlweise: v.union(v.literal("gespeichert"), v.literal("neu")),
    karteSpeichern: v.boolean(),
    adresse: v.optional(adresseV),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    kaufId: Id<"leserKaeufe">;
    status: "bezahlt" | "bestaetigen" | "aktion";
    clientSecret?: string;
  }> => {
    const konfig = konfigOderFehler();
    const userId = await angemeldet(ctx);
    if (!args.widerrufsverzicht) {
      throw new Error(
        "Ohne Zustimmung zum sofortigen Zugriff (Widerrufsverzicht) ist kein Kauf möglich.",
      );
    }
    if (args.adresse) {
      await ctx.runMutation(internal.leserKasse.adresseSetzen, { userId, adresse: args.adresse });
    }
    const vb = await ctx.runQuery(internal.leserKasse.kaufVorbereiten, {
      userId,
      issueIds: args.issueIds,
      modus: konfig.modus,
    });
    if (!vb.adresse) throw new Error("Bitte die Rechnungsadresse angeben.");
    if (args.zahlweise === "gespeichert" && !vb.paymentMethodId) {
      throw new Error("Es ist keine Karte gespeichert.");
    }

    // Der Preis kommt aus dem Shop, genau so wird dort gebucht.
    const preis = await angebotHolen(vb.hefte, vb.adresse.land);
    if (preis.betragCents !== args.erwarteterBetragCents) {
      throw new Error(
        `Der Preis hat sich geändert, er beträgt jetzt ${(preis.betragCents / 100)
          .toFixed(2)
          .replace(".", ",")} €. Bitte noch einmal bestätigen.`,
      );
    }

    const stripe = stripeFuer(konfig.secretKey);
    const kunde = await stripeKunde(
      ctx,
      stripe,
      konfig,
      userId,
      vb.email,
      vb.stripeCustomerId,
      `${vb.adresse.vorname} ${vb.adresse.nachname}`,
    );
    const karteSpeichern = args.zahlweise === "neu" && args.karteSpeichern;
    const kaufId: Id<"leserKaeufe"> = await ctx.runMutation(internal.leserKasse.kaufAnlegen, {
      userId,
      email: vb.email,
      modus: konfig.modus,
      issueIds: vb.hefte.map((h) => h.issueId),
      skus: vb.hefte.map((h) => h.sku),
      betragCents: preis.betragCents,
      karteGespeichert: args.zahlweise === "gespeichert",
    });

    const gemeinsam: Record<string, unknown> = {
      amount: preis.betragCents,
      currency: "eur",
      customer: kunde,
      payment_method_types: ["card"],
      description: kaufBeschreibung(vb.hefte.map((h) => h.titel)),
      metadata: kaufMetadaten({ kaufId, userId, email: vb.email, skus: vb.hefte.map((h) => h.sku) }),
    };

    let pi: any;
    try {
      pi = await stripe(
        "POST",
        "payment_intents",
        args.zahlweise === "gespeichert"
          ? { ...gemeinsam, payment_method: vb.paymentMethodId!, confirm: true }
          : { ...gemeinsam, ...(karteSpeichern ? { setup_future_usage: "on_session" } : {}) },
        `leser-kauf-${kaufId}`,
      );
    } catch (e: any) {
      const piFehler = e instanceof StripeFehler ? e.paymentIntent : undefined;
      if (piFehler?.id) {
        await ctx.runMutation(internal.leserKasse.zahlungVermerken, { kaufId, paymentIntentId: piFehler.id });
      }
      const text =
        e instanceof StripeFehler && e.type === "card_error"
          ? kartenFehler(e.code, e.declineCode)
          : "Die Zahlung ließ sich nicht starten.";
      await ctx.runMutation(internal.leserKasse.kaufFehlgeschlagen, { kaufId, fehler: text });
      console.error(JSON.stringify({ event: "leser.kauf.stripefehler", kauf: kaufId, typ: e?.type, code: e?.code }));
      throw new Error(text);
    }
    await ctx.runMutation(internal.leserKasse.zahlungVermerken, { kaufId, paymentIntentId: pi.id });

    if (pi.status === "succeeded") {
      await ctx.runMutation(internal.leserKasse.zahlungEingegangen, {
        paymentIntentId: pi.id,
        betragCents: pi.amount_received,
        modus: konfig.modus,
        karteSpeichern: false,
      });
      return { kaufId, status: "bezahlt" };
    }
    if (pi.status === "requires_action") {
      return { kaufId, status: "aktion", clientSecret: pi.client_secret ?? undefined };
    }
    if (args.zahlweise === "neu" && pi.status === "requires_payment_method") {
      return { kaufId, status: "bestaetigen", clientSecret: pi.client_secret ?? undefined };
    }
    const text = kartenFehler(pi.last_payment_error?.code, pi.last_payment_error?.decline_code);
    await ctx.runMutation(internal.leserKasse.kaufFehlgeschlagen, { kaufId, fehler: text });
    throw new Error(text);
  },
});

/**
 * Nach der Bestaetigung im Browser: Stand bei Stripe nachfragen. Der Webhook
 * meldet dasselbe; wer zuerst kommt, startet die Bestellung im Shop.
 */
export const kaufPruefen = action({
  args: { kaufId: v.id("leserKaeufe") },
  handler: async (ctx, { kaufId }): Promise<{ status: string; fehler?: string }> => {
    const userId = await angemeldet(ctx);
    const d = await ctx.runQuery(internal.leserKasse.bestellungDaten, { kaufId });
    if (!d || d.kauf.userId !== userId) throw new Error("Kauf nicht gefunden.");
    const kauf = d.kauf;
    if (!kauf.paymentIntentId) return { status: kauf.status };
    const key = secretKeyFuer(kauf.modus);
    if (!key) return { status: kauf.status };
    const pi = await stripeFuer(key)("GET", `payment_intents/${kauf.paymentIntentId}`);
    if (pi.metadata?.source !== "leser" || pi.metadata?.kaufId !== kaufId) {
      throw new Error("Zahlung passt nicht zum Kauf.");
    }
    if (pi.status === "succeeded") {
      await ctx.runMutation(internal.leserKasse.zahlungEingegangen, {
        paymentIntentId: pi.id,
        betragCents: pi.amount_received,
        modus: kauf.modus,
        paymentMethodId: typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id,
        karteSpeichern: pi.setup_future_usage != null,
      });
      return { status: "bezahlt" };
    }
    if (pi.status === "requires_payment_method" || pi.status === "canceled") {
      const text = kartenFehler(pi.last_payment_error?.code, pi.last_payment_error?.decline_code);
      await ctx.runMutation(internal.leserKasse.kaufFehlgeschlagen, { kaufId, fehler: text });
      return { status: "fehlgeschlagen", fehler: text };
    }
    return { status: pi.status };
  },
});

/** Gespeicherte Karte bei Stripe loesen und im Konto vergessen. */
export const karteEntfernen = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const konfig = konfigOderFehler();
    const userId = await angemeldet(ctx);
    const karte = await ctx.runQuery(internal.leserKasse.karteDaten, { userId, modus: konfig.modus });
    if (karte?.paymentMethodId) {
      try {
        await stripeFuer(konfig.secretKey)("POST", `payment_methods/${karte.paymentMethodId}/detach`);
      } catch (e: any) {
        // Schon geloest oder geloescht: im Konto trotzdem vergessen.
        if (e?.code !== "resource_missing" && !/not attached/i.test(String(e?.message))) throw e;
      }
    }
    await ctx.runMutation(internal.leserKasse.karteVergessen, { userId, modus: konfig.modus });
    return null;
  },
});

// --- Hintergrund ---------------------------------------------------------------

/** Karte nach einem Kauf mit „Karte speichern“ im Konto vermerken. */
export const karteMerken = internalAction({
  args: {
    userId: v.id("users"),
    modus: v.union(v.literal("test"), v.literal("live")),
    paymentMethodId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { userId, modus, paymentMethodId }): Promise<null> => {
    const key = secretKeyFuer(modus);
    if (!key) return null;
    const pm = await stripeFuer(key)("GET", `payment_methods/${paymentMethodId}`);
    const kunde = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
    if (!pm.card || !kunde) return null;
    await ctx.runMutation(internal.leserKasse.karteSetzen, {
      userId,
      modus,
      stripeCustomerId: kunde,
      paymentMethodId: pm.id,
      marke: pm.card.brand,
      letzte4: pm.card.last4,
      ablaufMonat: pm.card.exp_month,
      ablaufJahr: pm.card.exp_year,
      wallet: pm.card.wallet?.type ?? undefined,
    });
    return null;
  },
});

/**
 * Bezahlten Kauf im Shop buchen (`create_order`). Idempotent ueber den
 * PaymentIntent; Wiederholungen plant `bestellungErgebnis`.
 */
export const bestellungAnlegen = internalAction({
  args: { kaufId: v.id("leserKaeufe") },
  returns: v.null(),
  handler: async (ctx, { kaufId }): Promise<null> => {
    const d = await ctx.runQuery(internal.leserKasse.bestellungDaten, { kaufId });
    if (!d) return null;
    const { kauf, adresse } = d;
    if (kauf.status !== "bezahlt" && kauf.status !== "fehler") return null;
    if (!kauf.paymentIntentId || !adresse) {
      await ctx.runMutation(internal.leserKasse.bestellungErgebnis, {
        kaufId,
        ok: false,
        wiederholen: false,
        fehler: "Zahlung oder Rechnungsadresse fehlt",
      });
      return null;
    }
    let antwort: Record<string, any>;
    try {
      antwort = await callShopApi(
        "create_order",
        {
          mode: kauf.modus,
          payment_intent: kauf.paymentIntentId,
          amount_cents: kauf.betragCents,
          email: kauf.email,
          skus: kauf.skus,
          ...adresseFuerShop(adresse),
        },
        { timeoutMs: 60_000 },
      );
    } catch (e) {
      const fehler = e instanceof ShopApiError ? `${e.code ?? "fehler"}: ${e.message}` : String(e);
      await ctx.runMutation(internal.leserKasse.bestellungErgebnis, {
        kaufId,
        ok: false,
        wiederholen: true,
        fehler: fehler.slice(0, 500),
      });
      return null;
    }
    const warnungen: string[] = Array.isArray(antwort.warnings) ? antwort.warnings.map(String) : [];
    await ctx.runMutation(internal.leserKasse.bestellungErgebnis, {
      kaufId,
      ok: true,
      wiederholen: false,
      shopOrderId: Number(antwort.id_order) || undefined,
      shopReference: typeof antwort.reference === "string" ? antwort.reference : undefined,
      shopState: Number(antwort.state) || undefined,
      bezahltImShop: antwort.paid === true && warnungen.length === 0,
      fehler: warnungen.join(" ") || undefined,
    });
    // Bestellnummer an die Zahlung schreiben, fuer den Abgleich im Stripe-Dashboard.
    const key = secretKeyFuer(kauf.modus);
    if (key && typeof antwort.reference === "string") {
      try {
        await stripeFuer(key)("POST", `payment_intents/${kauf.paymentIntentId}`, {
          description: `Bestellung ${antwort.reference} (Leser)`,
          metadata: { shop_order: String(antwort.id_order), shop_reference: antwort.reference },
        });
      } catch (e) {
        console.warn(JSON.stringify({ event: "leser.pi.update", fehler: String((e as Error).message) }));
      }
    }
    return null;
  },
});

/** Erstattung in Stripe an den Shop melden; der setzt „Erstattet“ und entzieht. */
export const erstattungMelden = internalAction({
  args: { paymentIntentId: v.string() },
  returns: v.null(),
  handler: async (ctx, { paymentIntentId }): Promise<null> => {
    const kauf = await ctx.runQuery(internal.leserKasse.kaufNachZahlung, { paymentIntentId });
    if (!kauf || !kauf.shopOrderId) {
      console.warn(JSON.stringify({ event: "leser.erstattung.ohne_bestellung", pi: paymentIntentId }));
      return null;
    }
    const modus: StripeModus = kauf.modus;
    try {
      const a = await callShopApi("refund_order", { mode: modus, payment_intent: paymentIntentId }, { timeoutMs: 60_000 });
      if (a.full === true) {
        await ctx.runMutation(internal.leserKasse.erstattetVermerken, {
          paymentIntentId,
          shopState: Number(a.state) || undefined,
        });
      }
      console.log(JSON.stringify({ event: "leser.erstattung", pi: paymentIntentId, voll: a.full, state: a.state }));
    } catch (e) {
      console.error(JSON.stringify({ event: "leser.erstattung.fehler", pi: paymentIntentId, fehler: String((e as Error).message) }));
      throw e;
    }
    return null;
  },
});
