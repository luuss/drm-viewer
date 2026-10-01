import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useConvexAuth, useQuery } from "convex/react";
import { api, formatEuro } from "../lib/api";
import Icon from "../components/Icon";
import { heraus, hinein, useWarenkorb } from "../lib/warenkorb";

export default function SearchPage() {
  const [term, setTerm] = useState("");
  const { isAuthenticated } = useConvexAuth();
  const auswahl = useWarenkorb();
  const trimmed = term.trim();
  const active = trimmed.length >= 3;
  // Volltext nur in freigeschalteten Heften; aus allen anderen die Verzeichnisse.
  const results = useQuery(
    api.articles.search,
    active && isAuthenticated ? { term: trimmed } : "skip",
  );
  const kiosk = useQuery(api.tocPreview.searchCatalog, active ? { term: trimmed } : "skip");

  const eigene = isAuthenticated ? results : [];
  const laeuft = active && (eigene === undefined || kiosk === undefined);
  const anzahl = (eigene?.length ?? 0) + (kiosk?.length ?? 0);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Suche</h2>
        <p className="hint">
          {isAuthenticated
            ? "Durchsucht den Text Ihrer freigeschalteten Ausgaben und die Inhaltsverzeichnisse aller Ausgaben im Kiosk."
            : "Durchsucht die Inhaltsverzeichnisse aller Ausgaben im Kiosk."}
        </p>
      </div>

      <section>
        <label>
          Suchbegriff
          <span className="search-field">
            <Icon name="search" />
            <input
              className="search-input"
              placeholder="z.B. Energiepolitik"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              autoFocus
            />
          </span>
        </label>

        {/* Jeder Zustand der Suche bekommt eine eigene Zeile an derselben
            Stelle — leer, zu kurz, laeuft, Treffer. Sonst wirkt die Ansicht
            zwischen Eingabe und Ergebnis kaputt. */}
        {trimmed.length === 0 && (
          <p className="hint">Noch kein Begriff eingegeben.</p>
        )}
        {trimmed.length > 0 && !active && <p className="hint">Mindestens drei Zeichen.</p>}
        {laeuft && <p className="hint">Suche läuft...</p>}

        {active && !laeuft && anzahl === 0 && (
          <div className="empty">
            <p>Nichts gefunden zu „{trimmed}".</p>
          </div>
        )}

        {active && !laeuft && eigene && eigene.length > 0 && (
          <>
            <h3>In Ihren Ausgaben</h3>
            <ul className="search-results">
              {eigene.map((r) => (
                <li key={r._id}>
                  <Link to={`/reader/${r.issueId}?article=${r._id}`}>
                    <span className="title">{r.title} <Icon name="arrow-right" /></span>
                  </Link>
                  <div className="meta">
                    {r.issueTitle} · Seite {r.pageIndex + 1}
                  </div>
                  <p className="snippet">{r.snippet}</p>
                </li>
              ))}
            </ul>
          </>
        )}

        {active && !laeuft && kiosk && kiosk.length > 0 && (
          <>
            <h3>Im Kiosk</h3>
            <ul className="search-results kiosk-hits">
              {kiosk.map((h) => (
                <li key={h._id}>
                  <Link to={`/issue/${h.slug}?bild=inhalt`} className="kiosk-hit-cover">
                    {h.coverUrl ? (
                      <img src={h.coverUrl} alt={h.displayTitle} loading="lazy" />
                    ) : (
                      <div className="cover-placeholder">{h.displayTitle[0]}</div>
                    )}
                  </Link>
                  <div className="kiosk-hit-body">
                    <Link to={`/issue/${h.slug}?bild=inhalt`}>
                      <span className="title">
                        {h.publicationName && h.publicationName !== h.displayTitle
                          ? `${h.publicationName} · ${h.displayTitle}`
                          : h.displayTitle}{" "}
                        <Icon name="arrow-right" />
                      </span>
                    </Link>
                    {h.edition && <div className="meta">{h.edition}</div>}
                    <ul className="kiosk-hit-entries">
                      {h.entries.map((e) => (
                        <li key={e._id}>
                          <span>
                            {e.section && <span className="section">{e.section}: </span>}
                            <Markiert text={e.label} begriff={trimmed} />
                          </span>
                          {e.page && <span className="page">S. {e.page}</span>}
                        </li>
                      ))}
                      {h.more > 0 && <li className="more">+ {h.more}</li>}
                    </ul>
                    <div className="kiosk-hit-buy">
                      <span className="price">{formatEuro(h.priceAmountCents)}</span>
                      {h.shopSku && (
                        <button
                          type="button"
                          className={`btn secondary small${auswahl.includes(h._id) ? " on" : ""}`}
                          aria-pressed={auswahl.includes(h._id)}
                          onClick={() =>
                            auswahl.includes(h._id) ? heraus(h._id) : hinein(h._id)
                          }
                        >
                          <Icon name="cart" size={15} />
                          {auswahl.includes(h._id) ? "Im Warenkorb" : "In den Warenkorb"}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/** Hebt die Woerter des Suchbegriffs im Eintrag hervor, ohne Gross- und Kleinschreibung. */
function Markiert({ text, begriff }: { text: string; begriff: string }) {
  const woerter = begriff
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (woerter.length === 0) return <>{text}</>;
  const teile = text.split(new RegExp(`(${woerter.join("|")})`, "gi"));
  return (
    <>
      {teile.map((t, i) =>
        i % 2 === 1 ? <mark key={i}>{t}</mark> : <Fragment key={i}>{t}</Fragment>,
      )}
    </>
  );
}
