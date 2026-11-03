/**
 * Abo-Angebot je Titel, wie es der Verlag in seinen Bestellformularen fuehrt.
 *
 * Die Datei ist die Vorlage fuer `billing.seedSubscriptionPlans`: daraus
 * entstehen Stripe-Produkte und -Preise sowie die Zeilen in
 * `subscriptionPlans`. Verbindlich ist danach die Datenbank — die Oberflaeche
 * liest nie aus dieser Datei.
 *
 * Alle Preise sind Jahrespreise in Cent, inklusive Mehrwertsteuer.
 * Quelle: Preisblaetter "Abo 2027" des Verlags vom 26.10.2026
 * (docs/abo-preise-2027.md im Dachordner). Digital gibt es dort nur das
 * Online-Abo und die Gebuehr fuer die Zubuchung zur Druckausgabe; Schueler-,
 * Foerder- und Kombi-Abos gibt es nur gedruckt. Der Schlesier hat kein
 * Online-Abo. Digital gilt nur der Inlandspreis (27.10.2026).
 */

export type DeliveryRegion = "inland" | "ausland" | "luftpost";

/** Reihenfolge, in der die Liefergebiete angezeigt werden. */
export const REGION_ORDER: DeliveryRegion[] = ["inland", "ausland", "luftpost"];

export const REGION_LABEL: Record<DeliveryRegion, string> = {
  inland: "Inland",
  ausland: "Ausland",
  luftpost: "Ausland Luftpost",
};

export type CatalogTier = {
  /** Anzeigename der Abo-Art; gruppiert die Preisstufen. */
  name: string;
  /** Bedingung oder Verwendung, die zur Abo-Art gehoert. */
  note?: string;
  /** Jahrespreis je Liefergebiet. Fehlt ein Gebiet, gibt es die Stufe dort nicht. */
  prices: Partial<Record<DeliveryRegion, number>>;
  /**
   * Kombi-Abo: gilt nur zusammen mit einem Abo der Reihe `mit`. Abgeschlossen
   * wird es entweder mit deren Stufe `mitStufe` im selben Liefergebiet in
   * einem gemeinsamen Abo oder zu einem schon laufenden Digital-Abo dieser
   * Reihe; endet jenes, verlaengert es sich als `sonst` (leserAbo.ts).
   */
  kombi?: { mit: string; mitStufe: string; sonst: string };
};

export type CatalogEntry = {
  interval: "year";
  /** Die erste Abo-Art ist die, deren Inlandspreis der Kiosk zeigt. */
  tiers: CatalogTier[];
};

export const SUBSCRIPTION_CATALOG: Record<string, CatalogEntry> = {
  zuerst: {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        note: "12 Ausgaben im Jahr, nur digital",
        prices: { inland: 9600 },
      },
      {
        name: "Zubuchung zur Druckausgabe",
        note: "Nur für Abonnenten der gedruckten Ausgabe",
        prices: { inland: 1980 },
      },
    ],
  },
  dmz: {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        note: "6 Ausgaben im Jahr, nur digital",
        prices: { inland: 4980 },
      },
      {
        name: "Zubuchung zur Druckausgabe",
        note: "Nur für Abonnenten der gedruckten Ausgabe",
        prices: { inland: 1290 },
      },
    ],
  },
  "dmz-zeitgeschichte": {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        note: "6 Ausgaben im Jahr, nur digital",
        prices: { inland: 6540 },
      },
      {
        name: "Zubuchung zur Druckausgabe",
        note: "Nur für Abonnenten der gedruckten Ausgabe",
        prices: { inland: 1470 },
      },
    ],
  },
  schwertertraeger: {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        note: "4 Ausgaben im Jahr, nur digital",
        prices: { inland: 4700 },
      },
      {
        name: "Zubuchung zur Druckausgabe",
        note: "Nur für Abonnenten der gedruckten Ausgabe",
        prices: { inland: 1280 },
      },
    ],
  },
};

export type PlanVariant = {
  tier: string;
  tierNote?: string;
  region: DeliveryRegion;
  /** Vollstaendiger Name der Stufe, z.B. "Normalabonnement Inland". */
  name: string;
  priceAmountCents: number;
  /** Abo-Art mal zehn plus Liefergebiet: haelt die Katalogreihenfolge. */
  sortOrder: number;
};

/** Kombi-Regel einer Abo-Art, sofern sie eine ist. */
export function kombiRegel(slug: string, tier: string | undefined): CatalogTier["kombi"] | null {
  return SUBSCRIPTION_CATALOG[slug]?.tiers.find((t) => t.name === tier)?.kombi ?? null;
}

/** Kombi-Abos anderer Reihen, die ein Abo der Reihe `slug` voraussetzen. */
export function kombisMit(slug: string): { reihe: string; tier: string }[] {
  const out: { reihe: string; tier: string }[] = [];
  for (const [reihe, entry] of Object.entries(SUBSCRIPTION_CATALOG)) {
    for (const tier of entry.tiers) {
      if (tier.kombi?.mit === slug) out.push({ reihe, tier: tier.name });
    }
  }
  return out;
}

/** Alle Preisstufen eines Katalogeintrags in Anzeigereihenfolge. */
export function catalogVariants(entry: CatalogEntry): PlanVariant[] {
  const out: PlanVariant[] = [];
  entry.tiers.forEach((tier, tierIndex) => {
    REGION_ORDER.forEach((region, regionIndex) => {
      const cents = tier.prices[region];
      if (cents === undefined) return;
      out.push({
        tier: tier.name,
        tierNote: tier.note,
        region,
        name: tier.name,
        priceAmountCents: cents,
        sortOrder: tierIndex * 10 + regionIndex,
      });
    });
  });
  return out;
}

/**
 * Welche Stufen noch anzulegen sind. Gleiche Abo-Art und gleiches Gebiet
 * gilt als vorhanden — auch bei anderem Preis, damit ein wiederholter Lauf
 * keine zweite Stufe daneben stellt.
 */
export function missingVariants(
  entry: CatalogEntry,
  existing: { tier?: string; region?: string }[],
): PlanVariant[] {
  return catalogVariants(entry).filter(
    (variant) =>
      !existing.some(
        (plan) => plan.tier === variant.tier && plan.region === variant.region,
      ),
  );
}
