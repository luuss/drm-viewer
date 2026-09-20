import { useState } from "react";
import { Link } from "react-router-dom";
import { Authenticated, useAction, useQuery } from "convex/react";
import { api, formatEuro, type Id , cleanError } from "../lib/api";

/** Kiosk: veroeffentlichte Ausgaben und die Abos je Titel. */
export default function KioskPage() {
  const issues = useQuery(api.issues.listPublished, {});
  const plans = useQuery(api.plans.list, {});
  const waiver = useQuery(api.consents.currentWaiver, {});
  const subscribe = useAction(api.billing.createSubscriptionCheckout);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (issues === undefined) return <div className="centered">Laden...</div>;

  async function startAbo(planId: Id<"subscriptionPlans">) {
    setErr(null);
    setBusy(planId as string);
    try {
      const origin = window.location.origin;
      const { url } = await subscribe({
        planId,
        successUrl: `${origin}/library?abo=1`,
        cancelUrl: `${origin}/kiosk`,
        withdrawalWaiver: accepted,
      });
      window.location.href = url;
    } catch (e: any) {
      setErr(cleanError(e) ?? "Abo fehlgeschlagen");
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
            Das Abo schaltet jede Ausgabe frei, die während der Laufzeit
            erscheint — und das bei Abschluss aktuelle Heft. Freigeschaltete
            Ausgaben bleiben auch nach einer Kündigung lesbar.
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
                {p.publication && <div className="meta">{p.publication}</div>}
                {p.description && <p>{p.description}</p>}
                <div className="price">
                  {formatEuro(p.priceAmountCents)}
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
      <div className="issue-grid">
        {issues.map((i) => (
          <Link key={i._id} to={`/issue/${i.slug}`} className="issue-card">
            {i.coverUrl ? (
              <img src={i.coverUrl} alt={i.title} loading="lazy" />
            ) : (
              <div className="cover-placeholder">{i.title[0]}</div>
            )}
            <div className="issue-card-body">
              <div className="title">{i.title}</div>
              <div className="meta">{i.issueNumber ?? ""}</div>
              <div className="price">{formatEuro(i.priceAmountCents)}</div>
            </div>
          </Link>
        ))}
        {issues.length === 0 && <p className="hint">Noch keine Ausgabe veröffentlicht.</p>}
      </div>
    </div>
  );
}
