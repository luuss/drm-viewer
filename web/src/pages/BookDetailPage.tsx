import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useAction, useQuery } from "convex/react";
import { Authenticated, Unauthenticated } from "convex/react";
import { api, type Id } from "../lib/convex";

export default function BookDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const bookId = id as Id<"books">;
  const book = useQuery(api.books.getBook, { bookId });
  const owned = useQuery(api.books.hasEntitlement, { bookId });
  const waiver = useQuery(api.consents.currentWaiver, {});
  const createCheckout = useAction(api.billing.createBookCheckout);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (book === undefined) return <div className="centered">Laden...</div>;
  if (book === null) return <div className="centered">Ausgabe nicht gefunden</div>;

  async function buy() {
    setErr(null);
    setBusy(true);
    try {
      const origin = window.location.origin;
      const { url } = await createCheckout({
        bookId,
        successUrl: `${origin}/checkout/success?book=${bookId}`,
        cancelUrl: `${origin}/book/${bookId}`,
        withdrawalWaiver: accepted,
      });
      window.location.href = url;
    } catch (e: any) {
      setErr(e?.message?.replace(/^\[.*?\]\s*/, "") || "Checkout fehlgeschlagen");
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
          <span className="hint"> inkl. MwSt.</span>
        </div>

        <Authenticated>
          {owned ? (
            <button className="btn" onClick={() => navigate(`/read/${bookId}`)}>
              Jetzt lesen
            </button>
          ) : (
            <>
              <label className="consent">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  {waiver?.text ??
                    "Ich verlange den sofortigen Zugriff und verliere damit mein Widerrufsrecht."}{" "}
                  (<Link to="/widerruf">Widerrufsbelehrung</Link>)
                </span>
              </label>
              <button className="btn" onClick={buy} disabled={busy || !accepted}>
                {busy ? "..." : "Kaufen"}
              </button>
              {!accepted && (
                <p className="hint">
                  Ohne diese Zustimmung dürfen wir erst nach 14 Tagen
                  freischalten.
                </p>
              )}
            </>
          )}
        </Authenticated>
        <Unauthenticated>
          <button className="btn" onClick={() => navigate("/")}>
            Zum Kauf anmelden
          </button>
        </Unauthenticated>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
