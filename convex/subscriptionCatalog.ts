/**
 * Abo-Angebot je Titel, wie es der Verlag in seinen Bestellformularen fuehrt.
 *
 * Die Datei ist die Vorlage fuer `billing.seedSubscriptionPlans`: daraus
 * entstehen Stripe-Produkte und -Preise sowie die Zeilen in
 * `subscriptionPlans`. Verbindlich ist danach die Datenbank — die Oberflaeche
 * liest nie aus dieser Datei.
 *
 * Alle Preise sind Jahrespreise in Cent, inklusive Mehrwertsteuer.
 * Quellen, Stand September 2026: zuerst.de/abo und die Bestellformulare fuer
 * DMZ, DMZ Zeitgeschichte und Schwertertraeger auf lesenundschenken.de.
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
        prices: { inland: 10440, ausland: 13320, luftpost: 15360 },
      },
      {
        name: "Schüler- und Studentenabonnement",
        note: "Kopie des Schüler- oder Studentenausweises erforderlich",
        prices: { inland: 9000, ausland: 11880, luftpost: 14160 },
      },
      {
        name: "Kombi-Abonnement",
        note: "Zusammen mit einem Abonnement der Deutschen Militärzeitschrift",
        prices: { inland: 9600, ausland: 12480 },
      },
      {
        name: "Förderabonnement",
        note: "Der Förderbetrag fließt in die Werbung von ZUERST!",
        prices: { inland: 12600, ausland: 15300, luftpost: 17700 },
      },
    ],
  },
  dmz: {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        prices: { inland: 5880, ausland: 7500 },
      },
      {
        name: "Schüler- und Studentenabonnement",
        note: "Kopie des Schüler- oder Studentenausweises erforderlich",
        prices: { inland: 5280, ausland: 6900 },
      },
      {
        name: "Förderabonnement",
        note: "Der Förderbetrag fließt in die Werbung der DMZ",
        prices: { inland: 6900, ausland: 8520 },
      },
    ],
  },
  "dmz-zeitgeschichte": {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        prices: { inland: 6480, ausland: 8160 },
      },
      {
        name: "Schüler- und Studentenabonnement",
        note: "Kopie des Schüler- oder Studentenausweises erforderlich",
        prices: { inland: 5880, ausland: 7560 },
      },
      {
        name: "Förderabonnement",
        note: "Der Förderbetrag fließt in die Werbung der DMZ Zeitgeschichte",
        prices: { inland: 7500, ausland: 9180 },
      },
    ],
  },
  schwertertraeger: {
    interval: "year",
    tiers: [
      {
        name: "Normalabonnement",
        prices: { inland: 5520, ausland: 6560 },
      },
      {
        name: "Schüler- und Studentenabonnement",
        note: "Kopie des Schüler- oder Studentenausweises erforderlich",
        prices: { inland: 4920, ausland: 5920 },
      },
      {
        name: "Förderabonnement",
        note: "Der Förderbetrag fließt in die Werbung des Schwerterträgers",
        prices: { inland: 6380, ausland: 7540 },
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
        name: `${tier.name} ${REGION_LABEL[region]}`,
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
