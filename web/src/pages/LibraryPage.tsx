import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../lib/convex";

export default function LibraryPage() {
  const books = useQuery(api.books.myLibrary, {});

  if (books === undefined) return <div className="centered">Laden...</div>;

  return (
    <div className="page">
      <h2>Meine Bücher</h2>
      {books.length === 0 ? (
        <div className="empty">
          <p>Du hast noch keine Bücher.</p>
          <Link to="/shop" className="btn">Zum Shop</Link>
        </div>
      ) : (
        <div className="book-grid">
          {books.map((b) => (
            <Link key={b._id} to={`/read/${b._id}`} className="book-card">
              {b.coverUrl ? (
                <img src={b.coverUrl} alt={b.title} />
              ) : (
                <div className="cover-placeholder">{b.title[0]}</div>
              )}
              <div className="book-card-body">
                <div className="title">{b.title}</div>
                <div className="meta">
                  {b.currentPage > 0
                    ? `Seite ${b.currentPage + 1} / ${b.pageCount}`
                    : `${b.pageCount} Seiten`}
                </div>
                {b.currentPage > 0 && <span className="badge">Weiterlesen</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
