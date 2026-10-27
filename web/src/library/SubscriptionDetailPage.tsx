import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Authenticated, Unauthenticated, useAction, useQuery } from "convex/react";
import { api, formatEuro, type Id, cleanError } from "../lib/api";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";

/** Kostenloses Leseexemplar beim Verlag, je Titel. */
const SAMPLE_COPY_URL: Record<string, string> = {
  zuerst: "https://zuerst.de/probeexemplar/",
  dmz: "https://lesenundschenken.de/module/luszeitformulare/formular?f=probeexemplar&zeitschrift=DMZ",
  "dmz-zeitgeschichte":
    "https://lesenundschenken.de/module/luszeitformulare/formular?f=probeexemplar&zeitschrift=DMZ-Zeitgeschichte",
  schwertertraeger:
    "https://lesenundschenken.de/module/luszeitformulare/formular?f=probeexemplar&zeitschrift=Schwertertr%C3%A4ger",
};

/**
 * Abo-Seite eines Titels. Abgeschlossen wird das Digital-Jahresabo ueber
 * Stripe Checkout im Konto des Ladens (leserAbo.abschliessen); gibt es
 * mehrere Preisstufen, waehlt der Kunde hier. Ohne kaeufliche Stufe fuehrt
 * der Knopf in den Laden. Der alte eigene Checkout (`STRIPE_CHECKOUT_ENABLED`)
 * bleibt als Rueckweg.
 */
export default function SubscriptionDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const offer = useQuery(api.plans.offerBySlug, { slug });
  const waiver = useQuery(api.consents.currentWaiver, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const subscribeAlt = useAction(api.billing.createSubscriptionCheckout);
  const abschliessen = useAction(api.leserAbo.abschliessen);
  const kombi = useQuery(api.leserAbo.kombiAngebot, { slug });
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState<Id<"subscriptionPlans"> | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (offer === undefined || storefront === undefined) return <div className="centered">Laden...</div>;
  if (!offer) {
    return (
      <div className="centered">
        <p>Dieses Abo gibt es nicht.</p>
        <Link to="/" className="btn secondary">Zum Kiosk</Link>
      </div>
    );
  }

  const plans = offer.tiers.flatMap((t) => t.plans);
  // `?stufe=` waehlt eine Abo-Art vor, etwa vom Kombi-Hinweis der Partnerreihe.
  const vorgewaehlt = plans.find((p) => p.tier === params.get("stufe"));
  const selected = plans.find((p) => p._id === chosen) ?? vorgewaehlt ?? offer.headline;
  const kombiStufe = kombi?.stufen.find((s) => s.planId === selected?._id) ?? null;
  // Kombi: mit eigenem Abo der Partnerreihe nur der Kombipreis, sonst beide zusammen.
  const kombiZusammen = kombiStufe !== null && !kombiStufe.vorhanden;
  // Checkout nur mit kaeuflicher Preisstufe; sonst fuehrt der Knopf in den Laden.
  const stripeMode = (storefront.stripeAbo || storefront.stripeCheckout) && selected !== null;
  const perInterval = selected?.interval === "year" ? "pro Jahr" : "pro Monat";
  const sampleUrl = SAMPLE_COPY_URL[slug];

  async function startAbo() {
    if (!selected) return;
    setErr(null);
    setBusy(true);
    try {
      const origin = window.location.origin;
      const ziele = { successUrl: `${origin}/library?abo=1`, cancelUrl: `${origin}/abo/${slug}` };
      const { url } = storefront!.stripeAbo
        ? await abschliessen({
            planId: selected._id,
            widerrufsverzicht: accepted,
            ...ziele,
          })
        : await subscribeAlt({ planId: selected._id, withdrawalWaiver: accepted, ...ziele });
      window.location.href = url;
    } catch (e: any) {
      setErr(cleanError(e) ?? "Abo fehlgeschlagen");
      setBusy(false);
    }
  }

  return (
    <div className="page issue-detail">
      <div className="cover-wrap">
        {offer.coverUrl ? (
          <img src={offer.coverUrl} alt={offer.coverTitle ?? offer.publicationName} />
        ) : (
          <div className="cover-placeholder">{offer.publicationName[0]}</div>
        )}
      </div>
      <div className="issue-info">
        <h2>{offer.publicationName} im Abonnement</h2>
        <div className="meta">
          {stripeMode && selected
            ? `${selected.interval === "year" ? "Jahresabonnement" : "Monatsabonnement"} · Preise inkl. MwSt.`
            : "Digital-Abo · Preis und Laufzeit im Netzladen"}
        </div>
        {offer.currentIssue && (
          <div className="current-issue">
            <span className="label">Aktuelle Ausgabe</span>
            <strong>{offer.currentIssue.name}</strong>
            {(offer.currentIssue.subtitle ?? offer.currentIssue.designation) && (
              <span>{offer.currentIssue.subtitle ?? offer.currentIssue.designation}</span>
            )}
          </div>
        )}
        {stripeMode ? (
          <p className="hint">
            Das Abo schaltet jede Ausgabe frei, die während der Laufzeit
            erscheint — und das bei Abschluss aktuelle Heft. Freigeschaltete
            Ausgaben bleiben auch nach einer Kündigung lesbar.
          </p>
        ) : (
          <p className="hint">
            Das Digital-Abo schaltet während der gebuchten Laufzeit alle
            Ausgaben der Reihe frei, auch die bereits erschienenen.
          </p>
        )}
        {offer.description && <p>{offer.description}</p>}

        {stripeMode ? (
          <>
            {offer.tiers.length > 1 && (
              <fieldset className="subscription-choice">
                <legend>Abo-Art wählen</legend>
                <div className="subscription-prices">
                  {offer.tiers.map((tier) => {
                    const p = tier.plans[0];
                    return (
                      <label key={p._id} className={p._id === selected!._id ? "selected" : undefined}>
                        <input
                          type="radio"
                          name="plan"
                          value={p._id}
                          checked={p._id === selected!._id}
                          onChange={() => setChosen(p._id)}
                        />
                        <span>
                          {tier.tier}
                          {tier.note && <small>{tier.note}</small>}
                        </span>
                        <strong>{formatEuro(p.priceAmountCents)}</strong>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}

            {kombiStufe && (
              <p className="hint">
                {kombiStufe.vorhanden
                  ? `Ihr Digital-Abo von ${kombiStufe.partnerName} ist erkannt; ${offer.publicationName} kommt zum Kombipreis dazu. Endet das Abo von ${kombiStufe.partnerName}, verlängert sich dieses zum Preis des Normalabonnements.`
                  : kombiStufe.zusammenCents !== null
                    ? `Das Kombi-Abonnement schließt ${kombiStufe.partnerName} (${kombiStufe.partnerStufe}) mit ein: ein gemeinsames Abo für beide Hefte, gemeinsam verlängert und nur gemeinsam kündbar.`
                    : `Das Kombi-Abonnement gibt es zurzeit nur zu einem laufenden Digital-Abo von ${kombiStufe.partnerName}.`}
              </p>
            )}

            <div className="price">
              {formatEuro(
                kombiZusammen && kombiStufe.zusammenCents !== null
                  ? kombiStufe.zusammenCents
                  : selected!.priceAmountCents,
              )}
              <span className="hint">
                {" "}{perInterval} · {selected!.name}
                {kombiZusammen ? ` und ${kombiStufe.partnerName}` : ""}
              </span>
            </div>
            <p className="hint">
              Verlängert sich automatisch um ein Jahr und ist jederzeit zum Ende der Laufzeit
              kündbar, im Profil.
            </p>

            <Authenticated>
              <label className="consent">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  {waiver?.text ??
                    "Ich verlange den sofortigen Zugriff und verliere damit mein Widerrufsrecht."}{" "}
                  (<Link to="/widerruf">Widerrufsbelehrung</Link>)
                </span>
              </label>
              <button
                className="btn"
                onClick={startAbo}
                disabled={busy || !accepted || (kombiZusammen && kombiStufe.zusammenCents === null)}
                aria-busy={busy}
              >
                {busy ? "Wird geöffnet..." : <><Icon name="arrow-right" /> Abo abschließen</>}
              </button>
            </Authenticated>
            <Unauthenticated>
              <button className="btn" onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}>
                Zum Abschluss anmelden
              </button>
            </Unauthenticated>
            {err && <div className="err">{err}</div>}
          </>
        ) : (
          <>
            <div className="row actions">
              <a
                className="btn"
                href={offer.shopSubscriptionUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Digital-Abo im Netzladen <Icon name="arrow-right" />
              </a>
              <Unauthenticated>
                <button className="btn secondary" onClick={() => navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)}>
                  Anmelden
                </button>
              </Unauthenticated>
            </div>
            <ShopHinweis />
          </>
        )}

        {kombi?.alsPartner.map((k) => (
          <p className="hint" key={k.reiheSlug}>
            Zusammen mit {k.reiheName} gibt es das{" "}
            <Link to={`/abo/${k.reiheSlug}?stufe=${encodeURIComponent(k.tier)}`}>{k.tier}</Link>:{" "}
            {k.reiheName} zum Kombipreis und {offer.publicationName} in einem gemeinsamen Abo.
          </p>
        ))}

        {sampleUrl && (
          <a
            className="sample-copy"
            href={sampleUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="book-open" size={22} />
            <div>
              <strong>Kostenloses Leseexemplar</strong>
              <span>
                Erst einmal ein aktuelles Heft gedruckt probelesen
                <Icon name="arrow-right" size={15} />
              </span>
            </div>
          </a>
        )}
      </div>
    </div>
  );
}
