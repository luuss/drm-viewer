import { useState } from "react";
import { Link } from "react-router-dom";
import { Authenticated, useAction, useQuery } from "convex/react";
import { api, formatEuro, type Id , cleanError } from "../lib/api";
import Icon from "../components/Icon";

const printSubscriptions = [
  {
    name: "Normalabonnement",
    note: null,
    prices: [
      ["Inland", "104,40 €"],
      ["Ausland", "133,20 €"],
      ["Ausland Luftpost", "153,60 €"],
    ],
  },
  {
    name: "Schüler- und Studentenabonnement",
    note: "Kopie des Schüler- oder Studentenausweises erforderlich",
    prices: [
      ["Inland", "90,00 €"],
      ["Ausland", "118,80 €"],
      ["Ausland Luftpost", "141,60 €"],
    ],
  },
  {
    name: "Kombi-Abonnement",
    note: "Zusammen mit einem Abonnement der Deutschen Militärzeitschrift",
    prices: [
      ["Inland", "96,00 €"],
      ["Ausland", "124,80 €"],
    ],
  },
  {
    name: "Förderabonnement",
    note: "Der Förderbetrag fließt in die Werbung von ZUERST!",
    prices: [
      ["Inland", "126,00 €"],
      ["Ausland", "153,00 €"],
      ["Ausland Luftpost", "177,00 €"],
    ],
  },
] as const;

const PRINT_ORDER_URL = "https://zuerst.de/abo/";
const SAMPLE_ORDER_URL = "https://zuerst.de/probeexemplar/";

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
      <div className="page-head">
        <h2>Kiosk</h2>
        <p className="hint">
          Einzelne Ausgaben kaufen oder ein Abo abschließen. Gekaufte Ausgaben
          bleiben dauerhaft lesbar.
        </p>
      </div>

      <section className="subscription-overview" aria-labelledby="print-subscriptions-title">
        <div className="subscription-heading">
          <div>
            <span className="eyebrow">Bezugsmöglichkeiten</span>
            <h3 id="print-subscriptions-title">Abos</h3>
          </div>
          <a
            className="sample-copy"
            href={SAMPLE_ORDER_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="book-open" size={22} />
            <div>
              <strong>Kostenloses Leseexemplar</strong>
              <span>
                Jetzt kostenloses aktuelles Leseexemplar anfordern
                <Icon name="arrow-right" size={15} />
              </span>
            </div>
          </a>
        </div>

        <div className="subscription-grid">
          {printSubscriptions.map((subscription) => (
            <article className="subscription-card" key={subscription.name}>
              <div>
                <h4>{subscription.name}</h4>
                {subscription.note && <p>{subscription.note}</p>}
              </div>
              <div className="subscription-prices" aria-label={`Preise ${subscription.name}`}>
                {subscription.prices.map(([region, price]) => (
                  <a
                    key={region}
                    href={PRINT_ORDER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${subscription.name}, ${region}, ${price} bestellen`}
                  >
                    <span>{region}</span>
                    <strong>{price}</strong>
                    <span className="subscription-buy">
                      Bestellen <Icon name="arrow-right" size={15} />
                    </span>
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>
        <p className="subscription-order-note">
          Die Bestellung öffnet den offiziellen ZUERST!-Bestellprozess mit
          Rechnungsanschrift und Auswahl zwischen Rechnung, SEPA-Lastschrift und
          sicherer Online-Zahlung.
        </p>
      </section>

      {plans && plans.length > 0 && (
        <section>
          <h3>Digitale Abos</h3>
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
                    aria-busy={busy === p._id}
                    onClick={() => startAbo(p._id)}
                  >
                    {busy === p._id ? "Wird geöffnet..." : <><Icon name="arrow-right" /> Abo starten</>}
                  </button>
                </Authenticated>
              </div>
            ))}
          </div>
          {err && <div className="err">{err}</div>}
        </section>
      )}

      <section>
        <h3>Einzelausgaben</h3>
        <p className="hint">
          Eine gekaufte Ausgabe bleibt dauerhaft in Ihrer Bibliothek.
        </p>
        <div className="issue-grid">
          {issues.map((i) => (
            <Link key={i._id} to={`/issue/${i.slug}`} className="issue-card">
              <div className="issue-cover-preview">
                {i.coverUrl ? (
                  <img src={i.coverUrl} alt={i.title} loading="lazy" />
                ) : (
                  <div className="cover-placeholder">{i.title[0]}</div>
                )}
              </div>
              <div className="issue-card-body">
                <div className="title">{i.title}</div>
                <div className="meta">{i.issueNumber ?? ""}</div>
                <div className="price">{formatEuro(i.priceAmountCents)}</div>
                <div className="card-action">
                  Ausgabe ansehen <Icon name="arrow-right" />
                </div>
              </div>
            </Link>
          ))}
        </div>
        {issues.length === 0 && (
          <div className="empty">
            <p>Noch keine Ausgabe veröffentlicht.</p>
          </div>
        )}
      </section>
    </div>
  );
}
