/**
 * Schlanker Stripe-Client ueber `fetch`, fuer Aktionen in der normalen
 * Convex-Laufzeit. Grund: auf dem Verlagsserver erreichen `"use node"`-
 * Aktionen das Backend nicht (Rueckruf ohne /convex-Praefix landet beim
 * Kachel-Gateway, siehe drm-viewer-g8p). Ohne Node-Laufzeit kein Stripe-SDK.
 */

export class StripeFehler extends Error {
  type?: string;
  code?: string;
  declineCode?: string;
  status: number;
  paymentIntent?: any;
  constructor(status: number, e: any) {
    super(String(e?.message ?? `Stripe HTTP ${status}`));
    this.status = status;
    this.type = e?.type;
    this.code = e?.code;
    this.declineCode = e?.decline_code;
    this.paymentIntent = e?.payment_intent;
  }
}

/** Parameter wie Stripe sie als Formular erwartet: a[b][0]=c. */
export function formular(params: Record<string, unknown>, praefix = ""): string[] {
  const out: string[] = [];
  for (const [k, wert] of Object.entries(params)) {
    if (wert === undefined) continue;
    const name = praefix ? `${praefix}[${k}]` : k;
    if (wert === null) {
      out.push(`${encodeURIComponent(name)}=`);
    } else if (Array.isArray(wert)) {
      wert.forEach((w, i) => {
        if (w !== null && typeof w === "object") out.push(...formular(w as Record<string, unknown>, `${name}[${i}]`));
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(w))}`);
      });
    } else if (typeof wert === "object") {
      out.push(...formular(wert as Record<string, unknown>, name));
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(wert))}`);
    }
  }
  return out;
}

export type StripeAufruf = (
  methode: "GET" | "POST" | "DELETE",
  pfad: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string,
) => Promise<any>;

export function stripeClient(secretKey: string, doFetch: typeof fetch = fetch): StripeAufruf {
  return async (methode, pfad, params, idempotencyKey) => {
    const text = params ? formular(params).join("&") : "";
    const url =
      methode === "GET" && text ? `https://api.stripe.com/v1/${pfad}?${text}` : `https://api.stripe.com/v1/${pfad}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let letzter: unknown = null;
    for (let versuch = 0; versuch < 3; versuch++) {
      let r: Response;
      try {
        r = await doFetch(url, { method: methode, headers, body: methode === "GET" ? undefined : text });
      } catch (e) {
        letzter = e;
        continue;
      }
      const json: any = await r.json().catch(() => null);
      if (r.ok) return json;
      // Nur bei Netz- und Serverfehlern wiederholen; der Idempotenzschluessel schuetzt.
      if (r.status >= 500 || r.status === 429) {
        letzter = new StripeFehler(r.status, json?.error);
        continue;
      }
      throw new StripeFehler(r.status, json?.error);
    }
    if (letzter instanceof StripeFehler) throw letzter;
    throw new StripeFehler(0, { message: `Stripe nicht erreichbar: ${String((letzter as Error)?.message ?? letzter)}` });
  };
}
