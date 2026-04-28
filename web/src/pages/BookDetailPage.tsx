import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import { Authenticated, Unauthenticated } from "convex/react";
import { api, type Id } from "../lib/convex";

export default function BookDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const bookId = id as Id<"books">;
  const book = useQuery(api.books.getBook, { bookId });
  const owned = useQuery(api.books.hasEntitlement, { bookId });
  const createCheckout = useAction(api.stripe.createCheckoutSession);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (book === undefined) return <div className="centered">Laden...</div>;
  if (book === null) return <div className="centered">Buch nicht gefunden</div>;

  async function buy() {
    setErr(null);
    setBusy(true);
    try {
      const origin = window.location.origin;
      const { url } = await createCheckout({
        bookId,
        successUrl: `${origin}/checkout/success?book=${bookId}`,
        cancelUrl: `${origin}/book/${bookId}`,
      });
      window.location.href = url;
    } catch (e: any) {
      setErr(e.message || "Checkout fehlgeschlagen");
      setBusy(false);
    }
  }

  return (
    <div className="page book-detail">
      <div className="cover-wrap">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt={book.title} />
        ) : (
          <div className="cover-placeholder big">{book.title[0]}</div>
        )}
      </div>
      <div className="book-info">
        <h2>{book.title}</h2>
        <div className="meta">{book.pageCount} Seiten</div>
        {book.description && <p>{book.description}</p>}
        <div className="price big">
          {(book.priceCents / 100).toFixed(2)} {book.currency.toUpperCase()}
        </div>

        <Authenticated>
          {owned ? (
            <button className="btn" onClick={() => navigate(`/read/${bookId}`)}>
              Jetzt lesen
            </button>
          ) : (
            <button className="btn" onClick={buy} disabled={busy}>
              {busy ? "..." : "Kaufen"}
            </button>
          )}
        </Authenticated>
        <Unauthenticated>
          <button className="btn" onClick={() => navigate("/")}>
            Zum Kauf einloggen
          </button>
        </Unauthenticated>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
