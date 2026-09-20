import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../lib/convex";

export default function SearchPage() {
  const [term, setTerm] = useState("");
  const results = useQuery(
    api.articles.search,
    term.trim().length >= 3 ? { term: term.trim() } : "skip",
  );

  return (
    <div className="page">
      <h2>Suche</h2>
      <input
        className="search-input"
        placeholder="Begriff in allen freigeschalteten Ausgaben suchen"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        autoFocus
      />
      {term.trim().length > 0 && term.trim().length < 3 && (
        <p className="hint">Mindestens drei Zeichen.</p>
      )}
      {results === undefined && term.trim().length >= 3 && (
        <p className="hint">Suche läuft...</p>
      )}
      <ul className="search-results">
        {results?.map((r) => (
          <li key={r._id}>
            <Link to={`/read/${r.bookId}?article=${r._id}`}>
              <strong>{r.title}</strong>
            </Link>
            <div className="meta">
              {r.bookTitle} · Seite {r.pageStart}
            </div>
            <p>{r.snippet}</p>
          </li>
        ))}
        {results?.length === 0 && <li className="hint">Nichts gefunden.</li>}
      </ul>
    </div>
  );
}
