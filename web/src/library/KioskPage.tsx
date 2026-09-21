import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api, formatEuro } from "../lib/api";
import Icon from "../components/Icon";

const REGION_LABEL: Record<string, string> = {
  inland: "Inland",
  ausland: "Ausland",
  luftpost: "Ausland Luftpost",
};

/**
 * Kiosk: die Abos je Titel und die veroeffentlichten Ausgaben. Beides sind
 * Karten, die auf eine eigene Seite fuehren; gekauft wird erst dort. Das Abo
 * zeigt hier nur den Inlandspreis des Normalabonnements — die Abo-Art und das
 * Liefergebiet waehlt der Kunde auf der Abo-Seite.
 */
export default function KioskPage() {
  const issues = useQuery(api.issues.listPublished, {});
  const offers = useQuery(api.plans.offers, {});

  if (issues === undefined || offers === undefined) {
    return <div className="centered">Laden...</div>;
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

      {offers.length > 0 && (
        <section>
          <h3>Abonnements</h3>
          <p className="hint">
            Das Abo schaltet jede Ausgabe frei, die während der Laufzeit
            erscheint — und das bei Abschluss aktuelle Heft. Freigeschaltete
            Ausgaben bleiben auch nach einer Kündigung lesbar.
          </p>
          <div className="issue-grid">
            {offers.map((o) => (
              <Link
                key={o.publicationId}
                to={`/abo/${o.publicationSlug}`}
                className="issue-card"
              >
                <div className="issue-cover-preview">
                  {o.coverUrl ? (
                    <img
                      src={o.coverUrl}
                      alt={o.latestIssueTitle ?? o.publicationName}
                      loading="lazy"
                    />
                  ) : (
                    <div className="cover-placeholder">{o.publicationName[0]}</div>
                  )}
                </div>
                <div className="issue-card-body">
                  <div className="title">{o.publicationName}</div>
                  <div className="meta">
                    {[
                      o.headline.tier,
                      o.headline.region ? REGION_LABEL[o.headline.region] : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div className="price">
                    {formatEuro(o.headline.priceAmountCents)}
                    {o.headline.interval === "year" ? " / Jahr" : " / Monat"}
                  </div>
                  <div className="card-action">
                    Abo ansehen <Icon name="arrow-right" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
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
                <div className="meta">
                  {[i.publicationName, i.issueNumber].filter(Boolean).join(" · ")}
                </div>
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
