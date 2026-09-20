import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "../lib/api";

/**
 * Rahmen der Anwendung. Mit `?embed=1` faellt er weg — fuer die Einbettung in
 * einen bestehenden Shop, der Kopf und Fuss selbst mitbringt.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuthActions();
  const [params] = useSearchParams();
  const loc = useLocation();
  const embedded = params.get("embed") === "1" || loc.pathname.startsWith("/embed");

  if (embedded) return <main className="embedded">{children}</main>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          E-Magazin
        </Link>
        <nav>
          <Authenticated>
            <Link to="/library">Meine Ausgaben</Link>
            <Link to="/kiosk">Kiosk</Link>
            <Link to="/suche">Suche</Link>
            <EditorLink />
            <Link to="/account" className="user-badge">
              <UserBadge />
            </Link>
            <button className="link-btn" onClick={() => signOut()}>
              Abmelden
            </button>
          </Authenticated>
          <Unauthenticated>
            <Link to="/kiosk">Kiosk</Link>
            <Link to="/">Anmelden</Link>
          </Unauthenticated>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="app-footer">
        <Link to="/impressum">Impressum</Link>
        <Link to="/datenschutz">Datenschutz</Link>
        <Link to="/agb">AGB</Link>
        <Link to="/widerruf">Widerruf</Link>
      </footer>
    </div>
  );
}

function UserBadge() {
  const me = useQuery(api.users.me, {});
  return <>{me?.email ?? ""}</>;
}

function EditorLink() {
  const me = useQuery(api.users.me, {});
  if (!me?.isEditor) return null;
  return <Link to="/admin">Redaktion</Link>;
}
