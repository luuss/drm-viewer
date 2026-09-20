import { Link, useLocation } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "../lib/convex";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuthActions();
  const loc = useLocation();
  const isReader = loc.pathname.startsWith("/read/");

  if (isReader) return <>{children}</>;

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="brand">
          E-Magazin
        </Link>
        <nav>
          <Authenticated>
            <Link to="/library">Meine Ausgaben</Link>
            <Link to="/shop">Kiosk</Link>
            <Link to="/suche">Suche</Link>
            <AdminLink />
            <Link to="/profile" className="user-badge">
              <UserBadge />
            </Link>
            <button className="link-btn" onClick={() => signOut()}>
              Abmelden
            </button>
          </Authenticated>
          <Unauthenticated>
            <Link to="/shop">Kiosk</Link>
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
  if (!me) return null;
  return <>{me.email}</>;
}

function AdminLink() {
  const me = useQuery(api.users.me, {});
  if (!me?.isAdmin) return null;
  return <Link to="/admin">Redaktion</Link>;
}
