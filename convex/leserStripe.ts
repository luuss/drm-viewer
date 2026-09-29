/**
 * Kartenkauf im Leser: reine Hilfsfunktionen ohne Convex-Bezug, damit sie in
 * `"use node"`-Aktionen, im HTTP-Router und in Tests gleich laufen.
 *
 * Der Leser belastet die Karte selbst ueber Stripe (dasselbe Konto wie der
 * Shop). Gebucht wird danach im Shop (`create_order` der Shop-API), und erst
 * die Bestellung dort schaltet frei. Siehe docs/shop-integration.md,
 * Abschnitt „Kartenkauf im Leser“.
 *
 * Umgebung (Convex):
 *   LESER_STRIPE_MODE                      test | live, leer = Kartenkauf aus
 *   LESER_STRIPE_SECRET_KEY_TEST|_LIVE     Geheimschluessel des Shop-Kontos
 *   LESER_STRIPE_PUBLISHABLE_KEY_TEST|_LIVE
 *   LESER_STRIPE_WEBHOOK_SECRET_TEST|_LIVE Signaturgeheimnis des Endpunkts
 *                                          /hooks/stripe/webhook
 */

import { v } from "convex/values";

export type StripeModus = "test" | "live";

export type StripeKonfig = {
  modus: StripeModus;
  secretKey: string;
  publishableKey: string;
};

type Env = Record<string, string | undefined>;

function envVon(env?: Env): Env {
  return env ?? (process.env as Env);
}

/** Aktiver Modus, nur wenn die Schluessel dazu vollstaendig sind. */
export function stripeKonfig(env?: Env): StripeKonfig | null {
  const e = envVon(env);
  const modus = (e.LESER_STRIPE_MODE ?? "").trim().toLowerCase();
  if (modus !== "test" && modus !== "live") return null;
  const suffix = modus === "live" ? "LIVE" : "TEST";
  const secretKey = (e[`LESER_STRIPE_SECRET_KEY_${suffix}`] ?? "").trim();
  const publishableKey = (e[`LESER_STRIPE_PUBLISHABLE_KEY_${suffix}`] ?? "").trim();
  const praefix = modus === "live" ? "_live_" : "_test_";
  if (!secretKey.includes(praefix) || !publishableKey.startsWith(`pk${praefix}`)) {
    return null;
  }
  return { modus, secretKey, publishableKey };
}

/** Geheimschluessel eines bestimmten Modus (fuer Nacharbeiten an alten Kaeufen). */
export function secretKeyFuer(modus: StripeModus, env?: Env): string | null {
  const e = envVon(env);
  const key = (e[`LESER_STRIPE_SECRET_KEY_${modus === "live" ? "LIVE" : "TEST"}`] ?? "").trim();
  return key || null;
}

/** Signaturgeheimnisse beider Modi; ein Endpunkt je Modus, dieselbe Adresse. */
export function webhookGeheimnisse(env?: Env): { modus: StripeModus; secret: string }[] {
  const e = envVon(env);
  const out: { modus: StripeModus; secret: string }[] = [];
  for (const modus of ["live", "test"] as const) {
    const secret = (e[`LESER_STRIPE_WEBHOOK_SECRET_${modus.toUpperCase()}`] ?? "").trim();
    if (secret) out.push({ modus, secret });
  }
  return out;
}

// --- Webhook-Signatur ------------------------------------------------------

async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function gleich(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Kopf `Stripe-Signature: t=…,v1=…,v1=…` zerlegen. */
export function signaturKopf(kopf: string): { t: number; v1: string[] } | null {
  let t = NaN;
  const v1: string[] = [];
  for (const teil of kopf.split(",")) {
    const [k, wert] = teil.split("=", 2).map((s) => s?.trim() ?? "");
    if (k === "t") t = Number(wert);
    else if (k === "v1" && wert) v1.push(wert.toLowerCase());
  }
  if (!Number.isFinite(t) || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Stripe-Signatur pruefen (HMAC-SHA256 ueber `${t}.${rumpf}`), mit
 * Zeitfenster gegen Wiedereinspielen. Liefert den Modus, dessen Geheimnis
 * passt, sonst null.
 */
export async function webhookPruefen(
  rumpf: string,
  kopf: string | null,
  geheimnisse: { modus: StripeModus; secret: string }[],
  jetztMs: number = Date.now(),
  toleranzS = 300,
): Promise<StripeModus | null> {
  if (!kopf) return null;
  const k = signaturKopf(kopf);
  if (!k) return null;
  if (Math.abs(jetztMs / 1000 - k.t) > toleranzS) return null;
  for (const { modus, secret } of geheimnisse) {
    const erwartet = await hmacSha256Hex(secret, `${k.t}.${rumpf}`);
    if (k.v1.some((s) => gleich(s, erwartet))) return modus;
  }
  return null;
}

/** Signaturkopf bilden, wie Stripe es tut (fuer Tests und Probelaeufe). */
export async function signaturBilden(rumpf: string, secret: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rumpf}`)}`;
}

// --- Rechnungsadresse -----------------------------------------------------

export type Rechnungsadresse = {
  vorname: string;
  nachname: string;
  firma?: string;
  strasse: string;
  zusatz?: string;
  plz: string;
  ort: string;
  land: string;
};

export const adresseV = v.object({
  vorname: v.string(),
  nachname: v.string(),
  firma: v.optional(v.string()),
  strasse: v.string(),
  zusatz: v.optional(v.string()),
  plz: v.string(),
  ort: v.string(),
  land: v.string(),
});

/** Laender, in die der Leser verkauft (ISO-Code → Name). Der Shop kennt alle. */
export const LAENDER: Record<string, string> = {
  DE: "Deutschland",
  AT: "Österreich",
  CH: "Schweiz",
  LI: "Liechtenstein",
  LU: "Luxemburg",
  BE: "Belgien",
  NL: "Niederlande",
  DK: "Dänemark",
  FR: "Frankreich",
  IT: "Italien",
  ES: "Spanien",
  PL: "Polen",
  CZ: "Tschechien",
  SE: "Schweden",
  GB: "Vereinigtes Königreich",
  US: "Vereinigte Staaten",
};

const PLZ: Record<string, RegExp> = {
  DE: /^\d{5}$/,
  AT: /^\d{4}$/,
  CH: /^\d{4}$/,
  LI: /^\d{4}$/,
  LU: /^\d{4}$/,
  BE: /^\d{4}$/,
  DK: /^\d{4}$/,
  NL: /^\d{4}\s?[A-Za-z]{2}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  PL: /^\d{2}-\d{3}$/,
  CZ: /^\d{3}\s?\d{2}$/,
  SE: /^\d{3}\s?\d{2}$/,
};

function sauber(text: string | undefined, max: number): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Rechnungsadresse pruefen und bereinigen. Wirft einen deutschen Satz, der in
 * der Oberflaeche steht. Namen ohne Ziffern, wie PrestaShop es verlangt.
 */
export function adressePruefen(roh: Rechnungsadresse): Rechnungsadresse {
  const a: Rechnungsadresse = {
    vorname: sauber(roh.vorname, 60),
    nachname: sauber(roh.nachname, 60),
    firma: sauber(roh.firma, 100) || undefined,
    strasse: sauber(roh.strasse, 120),
    zusatz: sauber(roh.zusatz, 120) || undefined,
    plz: sauber(roh.plz, 12),
    ort: sauber(roh.ort, 60),
    land: sauber(roh.land, 2).toUpperCase(),
  };
  if (!a.vorname || !a.nachname) throw new Error("Bitte Vor- und Nachnamen angeben.");
  const name = /^[^0-9!<>,;?=+()@#"°{}_$%:¤|]+$/u;
  if (!name.test(a.vorname) || !name.test(a.nachname)) {
    throw new Error("Der Name enthält Zeichen, die der Shop nicht annimmt.");
  }
  if (!a.strasse) throw new Error("Bitte Straße und Hausnummer angeben.");
  if (!a.ort) throw new Error("Bitte den Ort angeben.");
  if (/[0-9!<>;?=+@#"°{}_$%]/.test(a.ort)) throw new Error("Der Ort enthält unzulässige Zeichen.");
  if (!LAENDER[a.land]) throw new Error("Dieses Land ist nicht auswählbar.");
  if (!a.plz) throw new Error("Bitte die Postleitzahl angeben.");
  const muster = PLZ[a.land];
  if (muster && !muster.test(a.plz)) throw new Error("Die Postleitzahl passt nicht zum Land.");
  return a;
}

/** Felder der Shop-API `create_order` zur Adresse. */
export function adresseFuerShop(a: Rechnungsadresse): Record<string, string> {
  return {
    firstname: a.vorname,
    lastname: a.nachname,
    company: a.firma ?? "",
    address1: a.strasse,
    address2: a.zusatz ?? "",
    postcode: a.plz,
    city: a.ort,
    country_iso: a.land,
  };
}

/** Rechnungsangaben fuer Stripe (`billing_details`). */
export function adresseFuerStripe(a: Rechnungsadresse) {
  return {
    name: `${a.vorname} ${a.nachname}`,
    address: {
      line1: a.strasse,
      line2: a.zusatz ?? undefined,
      postal_code: a.plz,
      city: a.ort,
      country: a.land,
    },
  };
}

// --- Kauf -----------------------------------------------------------------

export const MAX_HEFTE = 30;

/** Kennzeichen an jedem PaymentIntent des Lesers; der Shop-Webhook ignoriert ihn so. */
export const HERKUNFT = "leser";

/** Metadaten des PaymentIntents; Stripe erlaubt je Wert 500 Zeichen. */
export function kaufMetadaten(k: {
  kaufId: string;
  userId: string;
  email: string;
  skus: string[];
}): Record<string, string> {
  return {
    source: HERKUNFT,
    kaufId: k.kaufId,
    userId: k.userId,
    email: k.email.slice(0, 500),
    skus: k.skus.join(",").slice(0, 500),
  };
}

/** Beschreibung in Stripe (Kontoauszug-Dashboard, nicht Kontoauszug des Kunden). */
export function kaufBeschreibung(titel: string[]): string {
  const text = `Leser: ${titel.join(", ")}`;
  return text.length > 350 ? `${text.slice(0, 347)}...` : text;
}

/** Wartezeit bis zum naechsten Versuch, die Bestellung im Shop anzulegen. */
export function naechsterVersuchMs(versuche: number): number | null {
  const stufen = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000];
  return versuche < stufen.length ? stufen[versuche] : null;
}

/** Kartenname fuer Knoepfe: „Visa •••• 4242“. */
export function kartenName(k: { marke: string; letzte4: string }): string {
  const marken: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    diners: "Diners Club",
    jcb: "JCB",
    unionpay: "UnionPay",
    cartes_bancaires: "Cartes Bancaires",
  };
  return `${marken[k.marke] ?? k.marke} •••• ${k.letzte4}`;
}

/** Deutscher Satz zu einem Stripe-Fehler beim Belasten der Karte. */
export function kartenFehler(code: string | undefined, declineCode?: string): string {
  switch (declineCode ?? code) {
    case "insufficient_funds":
      return "Die Karte ist nicht ausreichend gedeckt.";
    case "expired_card":
      return "Die Karte ist abgelaufen.";
    case "incorrect_cvc":
      return "Die Prüfnummer der Karte stimmt nicht.";
    case "lost_card":
    case "stolen_card":
    case "pickup_card":
      return "Die Karte ist gesperrt.";
    case "authentication_required":
      return "Die Bank verlangt eine Bestätigung. Bitte erneut versuchen.";
    default:
      return "Die Karte wurde abgelehnt. Bitte eine andere Karte verwenden.";
  }
}
