import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../lib/api";
import Icon from "../components/Icon";

export default function SearchPage() {
  const [term, setTerm] = useState("");
  const trimmed = term.trim();
  const active = trimmed.length >= 3;
  const results = useQuery(api.articles.search, active ? { term: trimmed } : "skip");

  return (
    <div className="page">
      <div className="page-head">
        <h2>Suche</h2>
        <p className="hint">
          Durchsucht den Text aller Ausgaben, die für Sie freigeschaltet sind.
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
        {active && results === undefined && <p className="hint">Suche läuft...</p>}
        {active && results && results.length > 0 && (
          <p className="hint">
            {results.length} {results.length === 1 ? "Treffer" : "Treffer"}
          </p>
        )}

        {active && results && results.length === 0 ? (
          <div className="empty">
            <p>Nichts gefunden zu „{trimmed}".</p>
          </div>
        ) : (
          <ul className="search-results">
            {results?.map((r) => (
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
        )}
      </section>
    </div>
  );
}
