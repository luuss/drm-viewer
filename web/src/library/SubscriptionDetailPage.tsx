import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Authenticated, Unauthenticated, useAction, useQuery } from "convex/react";
import { api, formatEuro, type Id, cleanError } from "../lib/api";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";
import Kasse from "../components/Kasse";
import { aboEintrag, heraus, hinein, kassenUrl, useWarenkorb } from "../lib/warenkorb";

const REGION_LABEL: Record<string, string> = {
  inland: "Inland",
  ausland: "Ausland",
  luftpost: "Ausland Luftpost",
};

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
 * Abo-Seite eines Titels. Das Digital-Abo ist ein Artikel im Laden: mit
 * Artikelnummer wird es hier gekauft wie ein Heft — sofort mit Karte oder
 * ueber den Warenkorb, zusammen mit Heften. Ohne Artikelnummer fuehrt der
 * Knopf auf die Produktseite im Laden. Der eigene Checkout ueber Stripe-Abos
 * (Abo-Art und Liefergebiet) ist nur per Schalter (`STRIPE_CHECKOUT_ENABLED`) an.
 */
export default function SubscriptionDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const offer = useQuery(api.plans.offerBySlug, { slug });
  const waiver = useQuery(api.consents.currentWaiver, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const me = useQuery(api.users.me, {});
  // Kartenkauf im Leser (Stripe, gebucht im Shop). Aus: Sprung in die Kasse des Shops.
  const kasse = useQuery(api.leserKasse.status, {});
  const [params] = useSearchParams();
  const [kasseOffen, setKasseOffen] = useState(params.has("kaufen") || params.has("kauf"));
  const auswahl = useWarenkorb();
  const subscribe = useAction(api.billing.createSubscriptionCheckout);
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
  const selected = plans.find((p) => p._id === chosen) ?? offer.headline;
  // Eigener Checkout nur mit Schalter und Preisstufen; sonst fuehrt der
  // Knopf in den Laden.
  const stripeMode = storefront.stripeCheckout && selected !== null;
  const perInterval = selected?.interval === "year" ? "pro Jahr" : "pro Monat";
  const sampleUrl = SAMPLE_COPY_URL[slug];
  const abo = stripeMode ? null : offer.digitalAbo;
  const eintrag = aboEintrag(offer.publicationId);
  const imKorb = auswahl.includes(eintrag);
  const shopKasse = abo ? kassenUrl(storefront.shopUrl, [abo.sku], me?.email ?? null) : null;

  async function startAbo() {
    if (!selected) return;
    setErr(null);
    setBusy(true);
    try {
      const origin = window.location.origin;
      const { url } = await subscribe({
        planId: selected._id,
        successUrl: `${origin}/library?abo=1`,
        cancelUrl: `${origin}/abo/${slug}`,
        withdrawalWaiver: accepted,
      });
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
            : abo
              ? `Digital-Abo · ${abo.months} Monate`
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
            <fieldset className="subscription-choice">
              <legend>Abo-Art und Liefergebiet wählen</legend>
              <div className="subscription-grid">
                {offer.tiers.map((tier) => {
                  const holdsSelection = tier.plans.some((p) => p._id === selected!._id);
                  return (
                    <article
                      className={holdsSelection ? "subscription-card selected" : "subscription-card"}
                      key={tier.tier}
                    >
                      <div>
                        <h4>{tier.tier}</h4>
                        {tier.note && <p>{tier.note}</p>}
                      </div>
                      <div className="subscription-prices" aria-label={`Preise ${tier.tier}`}>
                        {tier.plans.map((p) => (
                          <label
                            key={p._id}
                            className={p._id === selected!._id ? "selected" : undefined}
                          >
                            <input
                              type="radio"
                              name="plan"
                              value={p._id}
                              checked={p._id === selected!._id}
                              onChange={() => setChosen(p._id)}
                            />
                            <span>{p.region ? REGION_LABEL[p.region] : p.name}</span>
                            <strong>{formatEuro(p.priceAmountCents)}</strong>
                          </label>
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            </fieldset>

            <div className="price">
              {formatEuro(selected!.priceAmountCents)}
              <span className="hint">
                {" "}{perInterval} · {selected!.name}
              </span>
            </div>

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
                disabled={busy || !accepted}
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
        ) : abo && shopKasse ? (
          <>
            {abo.priceAmountCents !== null && (
              <div className="price">
                {formatEuro(abo.priceAmountCents)}
                <span className="hint"> für {abo.months} Monate · inkl. MwSt.</span>
              </div>
            )}
            {kasse?.aktiv && kasseOffen ? (
              <Kasse
                issueIds={[]}
                aboPublicationIds={[offer.publicationId]}
                shopKasse={shopKasse}
                onFertig={() => heraus(eintrag)}
              />
            ) : (
              <div className="row actions">
                {kasse?.aktiv ? (
                  <button className="btn" onClick={() => setKasseOffen(true)}>
                    Sofort kaufen <Icon name="arrow-right" />
                  </button>
                ) : (
                  // Direkt in die Kasse des Ladens, das Abo liegt dort schon im Warenkorb.
                  <a className="btn" href={shopKasse} onClick={() => heraus(eintrag)}>
                    Sofort kaufen <Icon name="arrow-right" />
                  </a>
                )}
                {imKorb ? (
                  <Link className="btn secondary" to="/warenkorb">
                    <Icon name="cart" /> Im Warenkorb
                  </Link>
                ) : (
                  <button className="btn secondary" onClick={() => hinein(eintrag)}>
                    <Icon name="cart" /> In den Warenkorb
                  </button>
                )}
              </div>
            )}
            <ShopHinweis />
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
