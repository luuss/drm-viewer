import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../lib/convex";

export default function ShopPage() {
  const books = useQuery(api.books.list, {});
  if (books === undefined) return <div className="centered">Laden...</div>;

  return (
    <div className="page">
      <h2>Shop</h2>
      <div className="book-grid">
        {books.map((b) => (
          <Link key={b._id} to={`/book/${b._id}`} className="book-card">
            {b.coverUrl ? (
              <img src={b.coverUrl} alt={b.title} />
            ) : (
              <div className="cover-placeholder">{b.title[0]}</div>
            )}
            <div className="book-card-body">
              <div className="title">{b.title}</div>
              <div className="price">
                {(b.priceCents / 100).toFixed(2)} {b.currency.toUpperCase()}
              </div>
            </div>
          </Link>
        ))}
        {books.length === 0 && <p>Keine Bücher verfügbar.</p>}
      </div>
    </div>
  );
}
