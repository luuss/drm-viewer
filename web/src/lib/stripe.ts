import { loadStripe, type Stripe } from "@stripe/stripe-js";

/**
 * Stripe.js einmal je Schluessel laden. Der Schluessel kommt aus
 * `leserKasse.status` (Convex-Umgebung), damit der Wechsel test ↔ live ohne
 * neuen Bau der Oberflaeche geht.
 */
const geladen = new Map<string, Promise<Stripe | null>>();

export function stripeLaden(publishableKey: string): Promise<Stripe | null> {
  let p = geladen.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey, { locale: "de" });
    geladen.set(publishableKey, p);
  }
  return p;
}

/** Aussehen des Payment Element passend zum Leser (styles.css). */
export const STRIPE_AUSSEHEN = {
  theme: "stripe" as const,
  variables: {
    colorPrimary: "#d20007",
    colorText: "#1c1c1c",
    colorDanger: "#c00000",
    fontFamily: "'Open Sans', Arial, Helvetica, sans-serif",
    borderRadius: "7px",
    spacingUnit: "4px",
  },
};
