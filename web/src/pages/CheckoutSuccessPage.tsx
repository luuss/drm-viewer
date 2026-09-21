import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";

export default function CheckoutSuccessPage() {
  const [params] = useSearchParams();
  const bookId = params.get("book");
  useEffect(() => {
    // Webhook may take a moment. Library page reactively updates.
  }, []);
  return (
    <div className="centered">
      <div className="claim-box">
        <h2>Vielen Dank für deinen Kauf</h2>
        <p>
          Wir haben dir eine E-Mail mit einem Freischalt-Link geschickt. Du kannst
          das Buch aber auch direkt hier in Ihrer Bibliothek öffnen, sobald die
          Zahlung bestätigt ist (wenige Sekunden).
        </p>
        <Link className="btn" to={bookId ? `/read/${bookId}` : "/library"}>
          Zur Bibliothek
        </Link>
      </div>
    </div>
  );
}
