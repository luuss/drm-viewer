import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api, formatEuro } from "../lib/api";
import Icon from "../components/Icon";
import { heraus, hinein, useWarenkorb } from "../lib/warenkorb";
import ReihenKacheln from "../components/ReihenKacheln";
import { reiheVon } from "../lib/reihen";

const REGION_LABEL: Record<string, string> = {
  inland: "Inland",
  ausland: "Ausland",
  luftpost: "Ausland Luftpost",
};

/**
 * Kiosk: nur die Zeitschriften als Kacheln mit ihrem Schriftzug. Die Hefte
 * und das Abo stehen erst auf der Seite der Zeitschrift. Hefte ohne bekannte
 * Reihe haetten dort keine Seite; sie stehen deshalb hier als Karten. Das Abo
 * zeigt nur den Inlandspreis des Normalabonnements — die Abo-Art und das
 * Liefergebiet waehlt der Kunde auf der Abo-Seite.
 */
export default function KioskPage() {
  const issues = useQuery(api.issues.listPublished, {});
  const offers = useQuery(api.plans.offers, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const auswahl = useWarenkorb();

  if (issues === undefined || offers === undefined || storefront === undefined) {
    return <div className="centered">Laden...</div>;
  }

  const hefte = issues.filter((i) => !reiheVon(i.publicationName));
  const abos = offers.filter((o) => !reiheVon(o.publicationName));

  return (
    <div className="page">
      <div className="page-head kiosk-kopf">
        <span className="kicker">Kiosk</span>
        <h2>Für welche Zeitschrift interessieren Sie sich?</h2>
        <p className="hint">
          Wählen Sie eine Zeitschrift. Dort finden Sie alle Ausgaben und das Digital-Abo.
        </p>
      </div>

      <div id="zeitschriften">
        <ReihenKacheln hefte={issues} />
      </div>

      {abos.length > 0 && (
        <section>
          <h3>Abonnements</h3>
          <div className="issue-grid">
            {abos.map((o) => (
              <Link
                key={o.publicationId}
                to={`/abo/${o.publicationSlug}`}
                className="issue-card"
              >
                <div className="issue-cover-preview">
                  {o.coverUrl ? (
                    <img
                      src={o.coverUrl}
                      alt={o.coverTitle ?? o.publicationName}
                      loading="lazy"
                    />
                  ) : (
                    <div className="cover-placeholder">{o.publicationName[0]}</div>
                  )}
                </div>
                <div className="issue-card-body">
                  <div className="title">{o.publicationName}</div>
                  {o.currentIssue && o.currentIssue.name !== o.publicationName && (
                    <div className="meta strong">{o.currentIssue.name}</div>
                  )}
                  {o.currentIssue && (o.currentIssue.subtitle ?? o.currentIssue.designation) && (
                    <div className="meta">
                      {o.currentIssue.subtitle ?? o.currentIssue.designation}
                    </div>
                  )}
                  {/* Ohne eigenen Checkout gilt der Preis des Digital-Abos im
                      Laden; die Stripe-Preisstufen waeren irrefuehrend. */}
                  {storefront.stripeCheckout && o.headline ? (
                    <>
                      <div className="price">
                        {formatEuro(o.headline.priceAmountCents)}
                        {o.headline.interval === "year" ? " / Jahr" : " / Monat"}
                      </div>
                      <div className="price-note">
                        {[
                          o.headline.tier,
                          o.headline.region ? REGION_LABEL[o.headline.region] : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </>
                  ) : o.digitalAbo?.priceAmountCents ? (
                    <>
                      <div className="price">{formatEuro(o.digitalAbo.priceAmountCents)}</div>
                      <div className="price-note">Digital-Abo, {o.digitalAbo.months} Monate</div>
                    </>
                  ) : (
                    <div className="price-note">Digital-Abo im Netzladen</div>
                  )}
                  <div className="card-action">
                    Abo ansehen <Icon name="arrow-right" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {hefte.length > 0 && (
        <section>
          <h3>Einzelausgaben</h3>
          <div className="issue-grid">
            {hefte.map((i) => (
              <Link key={i._id} to={`/issue/${i.slug}`} className="issue-card">
                <div className="issue-cover-preview">
                  {i.coverUrl ? (
                    <img src={i.coverUrl} alt={i.displayTitle} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder">{i.displayTitle[0]}</div>
                  )}
                </div>
                <div className="issue-card-body">
                  <div className="title">{i.publicationName ?? i.displayTitle}</div>
                  {i.publicationName && i.displayTitle !== i.publicationName && (
                    <div className="meta strong">{i.displayTitle}</div>
                  )}
                  {i.edition && <div className="meta">{i.edition}</div>}
                  <div className="price">{formatEuro(i.priceAmountCents)}</div>
                  {i.shopSku && (
                    <button
                      type="button"
                      className={`card-cart${auswahl.includes(i._id) ? " on" : ""}`}
                      aria-pressed={auswahl.includes(i._id)}
                      onClick={(e) => {
                        // Die Karte ist ein Link; der Knopf waehlt nur aus.
                        e.preventDefault();
                        e.stopPropagation();
                        if (auswahl.includes(i._id)) heraus(i._id);
                        else hinein(i._id);
                      }}
                    >
                      <Icon name="cart" size={15} />
                      {auswahl.includes(i._id) ? "Im Warenkorb" : "In den Warenkorb"}
                    </button>
                  )}
                  <div className="card-action">
                    Ausgabe ansehen <Icon name="arrow-right" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
      {issues.length === 0 && (
        <div className="empty">
          <p>Noch keine Ausgabe veröffentlicht.</p>
        </div>
      )}
    </div>
  );
}
