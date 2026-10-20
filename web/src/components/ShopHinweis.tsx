import { Link, useLocation } from "react-router-dom";
import { Unauthenticated, Authenticated } from "convex/react";

/**
 * Wer im Laden auf lesenundschenken.de gekauft hat, meldet sich mit der
 * E-Mail-Adresse der Bestellung an. Die Freischaltung greift auch fuer ein
 * Konto, das erst nach dem Kauf angelegt wird.
 */
export default function ShopHinweis({ className = "hint" }: { className?: string }) {
  const { pathname, search } = useLocation();
  const login = `/login?next=${encodeURIComponent(pathname + search)}`;
  return (
    <p className={`${className} shop-hint`}>
      Gekauft im Netzladen? Mit derselben E-Mail{" "}
      <Unauthenticated>
        <Link to={login}>anmelden</Link>
      </Unauthenticated>
      <Authenticated>anmelden</Authenticated>, dann ist das Heft freigeschaltet.
    </p>
  );
}
