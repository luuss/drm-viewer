import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api, formatDate } from "../lib/api";

/** Nur Ausgaben, auf die der angemeldete Leser Zugriff hat. */
export default function LibraryPage() {
  const issues = useQuery(api.issues.myLibrary, {});
  if (issues === undefined) return <div className="centered">Laden...</div>;

  if (issues.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <h2>Meine Ausgaben</h2>
          <p className="hint">Freigeschaltete Hefte, dauerhaft lesbar.</p>
        </div>
        <div className="empty">
          <p>Noch keine Ausgabe freigeschaltet.</p>
          <Link className="btn" to="/kiosk">
            Zum Kiosk
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Meine Ausgaben</h2>
        <p className="hint">Freigeschaltete Hefte, dauerhaft lesbar.</p>
      </div>
      <div className="issue-grid">
        {issues.map((i) => (
          <Link key={i._id} to={`/reader/${i._id}`} className="issue-card">
            {i.coverUrl ? (
              <img src={i.coverUrl} alt={i.title} loading="lazy" />
            ) : (
              <div className="cover-placeholder">{i.title[0]}</div>
            )}
            <div className="issue-card-body">
              <div className="title">{i.title}</div>
              <div className="meta">
                {i.issueNumber ? `${i.issueNumber} · ` : ""}
                {i.pageCount} Seiten
              </div>
              <div className="cta">
                {i.progress ? (
                  <>
                    <span className="go">Weiterlesen</span>
                    <span className="where">
                      {i.progress.mode === "article"
                        ? "Artikel"
                        : `Seite ${i.progress.pageIndex + 1} von ${i.pageCount}`}
                    </span>
                  </>
                ) : (
                  <span className="go">Lesen</span>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
