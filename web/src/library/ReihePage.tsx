import { Link, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { useState, type CSSProperties } from "react";
import { api, formatEuro } from "../lib/api";
import Icon from "../components/Icon";
import SocialIcon from "../components/SocialIcon";
import { reiheMitSlug, reihenSchluessel } from "../lib/reihen";

/**
 * Die eigene Seite einer Zeitschrift: ihr Schriftzug, ihre Farbe, alle ihre
 * Hefte und ihr Abo, darunter Kontakt und Kanaele. Hefte, die der Leser schon
 * hat, sind in der Liste markiert; "Nur meine" blendet die anderen aus.
 * Zu den anderen Zeitschriften fuehrt der Link oben links. Die anderen Reihen stehen
 * erst ganz unten, hinter "Weitere Zeitschriften".
 */
export default function ReihePage() {
  const { slug } = useParams();
  const reihe = reiheMitSlug(slug);
  const issues = useQuery(api.issues.listPublished, {});
  const offers = useQuery(api.plans.offers, {});
  const eigene = useQuery(api.issues.myLibrary, {});
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const [nurMeine, setNurMeine] = useState(false);

  if (!reihe) {
    return (
      <div className="page">
        <p>Diese Zeitschrift gibt es hier nicht.</p>
        <Link className="btn" to="/">
          Zum Kiosk
        </Link>
      </div>
    );
  }
  if (issues === undefined || offers === undefined || eigene === undefined) {
    return <div className="centered">Laden...</div>;
  }

  const gehoert = (name: string | null) => reihenSchluessel(name) === reihe.slug;
  const hefte = issues.filter((i) => gehoert(i.publicationName));
  const abos = offers.filter((o) => gehoert(o.publicationName));
  const meine = eigene.filter((i) => gehoert(i.publicationName));
  const meineIds = new Set(meine.map((i) => i._id));
  // Alle veroeffentlichten Hefte, dazu eigene, die nicht (mehr) im Verkauf sind.
  const alle = [
    ...hefte.map((i) => ({ ...i, eigen: meineIds.has(i._id) })),
    ...meine
      .filter((i) => !hefte.some((h) => h._id === i._id))
      .map((i) => ({ ...i, slug: null, priceAmountCents: null, eigen: true })),
  ];
  const fortschritt = new Map(meine.map((i) => [i._id, i.progress]));
  const gezeigt = nurMeine ? alle.filter((i) => i.eigen) : alle;
  const k = reihe.kontakt;
  const abo = abos[0] ?? null;
  // Preis nur, wenn das Abo hier abgeschlossen werden kann (Stripe Checkout).
  const aboPreis =
    abo?.headline && storefront && (storefront.stripeAbo || storefront.stripeCheckout)
      ? abo.headline
      : null;

  return (
    <div
      className={`reihe-seite reihe-${reihe.slug}`}
      style={{ "--reihe": reihe.farbe } as CSSProperties}
    >
      <header className="reihe-kopf">
        <div className="reihe-kopf-innen">
          <nav className="reihe-pfad" aria-label="Pfad">
            <Link to="/#zeitschriften">
              <Icon name="arrow-left" size={16} /> Alle Zeitschriften
            </Link>
          </nav>
          <div className="reihe-kopf-zeile">
            <img
              src={reihe.hell}
              alt={reihe.alt}
              className={reihe.kasten ? "kasten" : undefined}
            />
            <div className="reihe-kopf-info">
              <p className="reihe-art">E-Paper · digital lesen</p>
              {reihe.untertitel && <p className="reihe-untertitel">{reihe.untertitel}</p>}
              <p className="reihe-zahl">
                {hefte.length} {hefte.length === 1 ? "Ausgabe" : "Ausgaben"}
                {meine.length > 0 && <> · {meine.length} davon Ihre</>}
              </p>
              {abos[0] && (
                <Link className="btn reihe-abo-knopf" to={`/abo/${abos[0].publicationSlug}`}>
                  Digital-Abo <Icon name="arrow-right" size={16} />
                </Link>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="page reihe-inhalt">
        <section>
          <div className="reihe-ausgaben-kopf">
            <h3>Ausgaben</h3>
            {meine.length > 0 && (
              <button
                type="button"
                className="nur-meine"
                aria-pressed={nurMeine}
                onClick={() => setNurMeine((v) => !v)}
              >
                <span className="kaestchen">
                  <Icon name="check" />
                </span>
                Nur meine Ausgaben
              </button>
            )}
          </div>
          {gezeigt.length === 0 && !abo ? (
            <div className="empty">
              <p>Noch keine Ausgabe als E-Paper veröffentlicht.</p>
            </div>
          ) : (
            <div className="issue-grid">
              {/* Das Abo steht immer zuerst, oben links vor den Heften. */}
              {abo && (
                <Link to={`/abo/${abo.publicationSlug}`} className="issue-card abo-kachel">
                  <div className="issue-cover-preview">
                    {abo.coverUrl ? (
                      <img src={abo.coverUrl} alt={abo.coverTitle ?? reihe.name} loading="lazy" />
                    ) : (
                      <div className="cover-placeholder">{reihe.name[0]}</div>
                    )}
                    <span className="eigen-band">Jahresabo</span>
                  </div>
                  <div className="issue-card-body">
                    <div className="title">{reihe.name} im Digital-Abo</div>
                    <div className="meta">Jede neue Ausgabe automatisch, auf jedem Gerät lesbar.</div>
                    {aboPreis && (
                      <div className="price">
                        {formatEuro(aboPreis.priceAmountCents)}
                        {aboPreis.interval === "year" ? " / Jahr" : " / Monat"}
                      </div>
                    )}
                    <div className="card-action">
                      Abo ansehen <Icon name="arrow-right" />
                    </div>
                  </div>
                </Link>
              )}
              {gezeigt.map((i) => (
                <Link
                  key={i._id}
                  to={i.eigen || !i.slug ? `/reader/${i._id}` : `/issue/${i.slug}`}
                  className={i.eigen ? "issue-card eigen" : "issue-card"}
                >
                  <div className="issue-cover-preview">
                    {i.coverUrl ? (
                      <img src={i.coverUrl} alt={i.displayTitle} loading="lazy" />
                    ) : (
                      <div className="cover-placeholder">{i.displayTitle[0]}</div>
                    )}
                    {i.eigen && (
                      <span className="eigen-band">
                        <Icon name="check" /> Ihre Ausgabe
                      </span>
                    )}
                  </div>
                  <div className="issue-card-body">
                    <div className="title">{i.displayTitle}</div>
                    {i.edition && <div className="meta">{i.edition}</div>}
                    {i.eigen ? (
                      <div className="cta">
                        <span className="go">
                          {fortschritt.get(i._id) ? "Weiterlesen" : "Lesen"}{" "}
                          <Icon name="arrow-right" />
                        </span>
                      </div>
                    ) : (
                      <>
                        {i.priceAmountCents !== null && (
                          <div className="price">{formatEuro(i.priceAmountCents)}</div>
                        )}
                        <div className="card-action">
                          Ausgabe ansehen <Icon name="arrow-right" />
                        </div>
                      </>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {abos.length > 0 && (
          <section className="reihe-abo">
            {abos.map((o) => (
              <Link
                key={o.publicationId}
                to={`/abo/${o.publicationSlug}`}
                className="reihe-abo-karte"
              >
                <div>
                  <div className="reihe-abo-titel">{reihe.name} im Digital-Abo</div>
                  <div className="reihe-abo-text">
                    Jede neue Ausgabe automatisch, auf jedem Gerät lesbar.
                  </div>
                </div>
                <span className="btn">
                  Abo ansehen <Icon name="arrow-right" />
                </span>
              </Link>
            ))}
          </section>
        )}

        <section className="reihe-kontakt">
          <h3>Kontakt</h3>
          {/* Oben die zwei Wege zur Zeitschrift: Druckausgabe im Netzladen und
              die eigene Website. Darunter Mail und Telefon. */}
          <div className="reihe-kontakt-wege">
            <a href={reihe.laden} target="_blank" rel="noopener" className="reihe-weg">
              <span>
                <span className="reihe-kontakt-art">Druckausgabe</span>
                <span className="reihe-weg-ziel">Im Netzladen bestellen</span>
              </span>
              <Icon name="arrow-right" />
            </a>
            {k.web && (
              <a href={k.web} target="_blank" rel="noopener" className="reihe-weg">
                <span>
                  <span className="reihe-kontakt-art">Internet</span>
                  <span className="reihe-weg-ziel">{k.web.replace(/^https?:\/\//, "")}</span>
                </span>
                <Icon name="arrow-right" />
              </a>
            )}
          </div>
          <div className="reihe-kontakt-raster">
            {k.mails.map((m) => (
              <div key={m.adresse}>
                <span className="reihe-kontakt-art">{m.label}</span>
                <a href={`mailto:${m.adresse}`}>{m.adresse}</a>
              </div>
            ))}
            <div>
              <span className="reihe-kontakt-art">Telefon</span>
              <a href={`tel:+49${k.tel.replace(/\D/g, "").replace(/^0/, "")}`}>{k.tel}</a>
            </div>
          </div>
          {k.social.length > 0 && (
            <div className="reihe-social">
              {k.social.map((s) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noopener"
                  className="reihe-social-link"
                  aria-label={`${reihe.name} bei ${s.name}`}
                >
                  <SocialIcon name={s.name} />
                  <span>{s.name}</span>
                </a>
              ))}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
