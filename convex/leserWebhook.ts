import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { HERKUNFT, kartenFehler, webhookGeheimnisse, webhookPruefen } from "./leserStripe";

/**
 * Stripe-Webhook des Lesers: `POST /hooks/stripe/webhook` (Convex-Pfad
 * `/stripe/webhook`). Je Modus ein Endpunkt in Stripe mit eigenem
 * Signaturgeheimnis (`LESER_STRIPE_WEBHOOK_SECRET_TEST|_LIVE`).
 *
 * Das Stripe-Konto gehoert dem Shop; hier kommen auch dessen Zahlungen an.
 * Beachtet wird nur, was der Leser selbst angelegt hat: PaymentIntents mit
 * `metadata.source = "leser"` bzw. Erstattungen zu einem Kauf im Leser.
 * Alles andere bekommt 200 und bleibt liegen.
 */
export const stripeWebhook = httpAction(async (ctx, request) => {
  const rumpf = await request.text();
  const modus = await webhookPruefen(
    rumpf,
    request.headers.get("stripe-signature"),
    webhookGeheimnisse(),
  );
  if (!modus) {
    return new Response(JSON.stringify({ ok: false, error: "bad_signature" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  let event: any;
  try {
    event = JSON.parse(rumpf);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const obj = event?.data?.object ?? {};
  const eigen = obj?.metadata?.source === HERKUNFT;

  switch (event?.type) {
    case "payment_intent.succeeded":
      if (!eigen) break;
      await ctx.runMutation(internal.leserKasse.zahlungEingegangen, {
        paymentIntentId: String(obj.id),
        betragCents: Number(obj.amount_received ?? obj.amount ?? 0),
        modus,
        paymentMethodId:
          typeof obj.payment_method === "string" ? obj.payment_method : obj.payment_method?.id,
        karteSpeichern: obj.setup_future_usage != null,
      });
      break;
    case "payment_intent.payment_failed":
      if (!eigen) break;
      await ctx.runMutation(internal.leserKasse.kaufFehlgeschlagen, {
        paymentIntentId: String(obj.id),
        fehler: kartenFehler(obj.last_payment_error?.code, obj.last_payment_error?.decline_code),
      });
      break;
    case "charge.refunded": {
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      if (!pi) break;
      const kauf = await ctx.runQuery(internal.leserKasse.kaufNachZahlung, { paymentIntentId: pi });
      if (kauf) {
        await ctx.scheduler.runAfter(0, internal.leserZahlung.erstattungMelden, {
          paymentIntentId: pi,
        });
      }
      break;
    }
    case "charge.dispute.created": {
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      if (!pi) break;
      const kauf = await ctx.runQuery(internal.leserKasse.kaufNachZahlung, { paymentIntentId: pi });
      if (kauf) {
        // Keine Automatik: der Betreiber entscheidet im Shop (Status, Erstattung).
        console.error(
          JSON.stringify({ event: "leser.rueckbuchung", pi, bestellung: kauf.shopReference ?? null }),
        );
      }
      break;
    }
  }
  return Response.json({ received: true });
});
