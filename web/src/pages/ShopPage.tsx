import { useState } from "react";
import { Link } from "react-router-dom";
import { Authenticated, useAction, useQuery } from "convex/react";
import { api, type Id } from "../lib/convex";

export default function ShopPage() {
  const books = useQuery(api.books.list, {});
  const plans = useQuery(api.plans.list, {});
  const waiver = useQuery(api.consents.currentWaiver, {});
  const subscribe = useAction(api.billing.createSubscriptionCheckout);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (books === undefined) return <div className="centered">Laden...</div>;

  async function startAbo(planId: Id<"subscriptionPlans">) {
    setErr(null);
    setBusy(planId as string);
    try {
      const origin = window.location.origin;
      const { url } = await subscribe({
        planId,
        successUrl: `${origin}/checkout/success?abo=1`,
        cancelUrl: `${origin}/shop`,
        withdrawalWaiver: accepted,
      });
      window.location.href = url;
    } catch (e: any) {
      setErr(e?.message?.replace(/^\[.*?\]\s*/, "") || "Abo-Checkout fehlgeschlagen");
      setBusy(null);
    }
  }

  return (
    <div className="page">
      <h2>Kiosk</h2>

      {plans && plans.length > 0 && (
        <section className="plans">
          <h3>Abo</h3>
          <p className="hint">
            Das Abo schaltet alle freigegebenen Ausgaben frei, solange es läuft.
            Kündigung jederzeit zum Laufzeitende im Profil.
          </p>
          <Authenticated>
            <label className="consent">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                {waiver?.text ?? "Sofortiger Zugriff gewünscht."} (
                <Link to="/widerruf">Widerrufsbelehrung</Link>)
              </span>
            </label>
          </Authenticated>
          <div className="plan-grid">
            {plans.map((p) => (
              <div className="plan-card" key={p._id}>
                <div className="title">{p.name}</div>
                {p.description && <p>{p.description}</p>}
                <div className="price">
                  {(p.priceCents / 100).toFixed(2)} {p.currency.toUpperCase()}
                  {p.interval === "year" ? " / Jahr" : " / Monat"}
                </div>
                <Authenticated>
                  <button
                    className="btn"
                    disabled={!accepted || busy !== null}
                    onClick={() => startAbo(p._id)}
                  >
                    {busy === p._id ? "..." : "Abo starten"}
                  </button>
                </Authenticated>
              </div>
            ))}
          </div>
          {err && <div className="err">{err}</div>}
        </section>
      )}

      <h3>Einzelausgaben</h3>
      <div className="book-grid">
        {books.map((b) => (
          <Link key={b._id} to={`/book/${b._id}`} className="book-card">
            {b.coverUrl ? (
              <img src={b.coverUrl} alt={b.title} />
            ) : (
              <div className="cover-placeholder">{b.title[0]}</div>
            )}
            <div className="book-card-body">
              <div className="title">{b.title}</div>
              <div className="price">
                {(b.priceCents / 100).toFixed(2)} {b.currency.toUpperCase()}
              </div>
            </div>
          </Link>
        ))}
        {books.length === 0 && <p>Keine Ausgaben verfügbar.</p>}
      </div>
    </div>
  );
}
