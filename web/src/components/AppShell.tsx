import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "../lib/api";
import Icon from "./Icon";

/**
 * Rahmen der Anwendung. Mit `?embed=1` faellt er weg — fuer die Einbettung in
 * einen bestehenden Shop, der Kopf und Fuss selbst mitbringt.
 *
 * Kopf, Inhalt und Fuss liegen in derselben Blattbreite (`.shell-inner`),
 * damit Marke, Ueberschrift und Fusszeile auf einer Flucht stehen.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuthActions();
  const [params] = useSearchParams();
  const loc = useLocation();
  const embedded = params.get("embed") === "1" || loc.pathname.startsWith("/embed");

  if (embedded) return <main className="embedded">{children}</main>;

  // Der Leser soll ohne Nachdenken sehen, wo er steht; ein Menue ohne Marke
  // fuer die eigene Stelle laesst jede Ansicht gleich aussehen.
  const here = (path: string) => (loc.pathname === path ? "here" : undefined);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="shell-inner">
          <Link to="/" className="brand">
            Lesen<span className="amp">&amp;</span>Schenken
            <span className="brand-sub">Digital</span>
          </Link>
          <nav>
            <Authenticated>
              <Link to="/library" className={here("/library")}>
                <Icon name="library" /> Meine Ausgaben
              </Link>
              <Link to="/kiosk" className={here("/kiosk")}>
                <Icon name="kiosk" /> Kiosk
              </Link>
              <Link to="/suche" className={here("/suche")}>
                <Icon name="search" /> Suche
              </Link>
              <EditorLink active={here("/admin")} />
              <Link to="/account" className="user-badge">
                <Icon name="user" />
                <UserBadge />
              </Link>
              <button className="btn secondary small" onClick={() => signOut()}>
                <Icon name="logout" />
                Abmelden
              </button>
            </Authenticated>
            <Unauthenticated>
              <Link to="/kiosk" className={here("/kiosk")}>
                <Icon name="kiosk" /> Kiosk
              </Link>
              <Link to="/" className="btn secondary small">
                <Icon name="login" /> Anmelden
              </Link>
            </Unauthenticated>
          </nav>
        </div>
      </header>

      <main>{children}</main>

      <footer className="app-footer">
        <div className="shell-inner">
          <span className="copy">© {new Date().getFullYear()} Lesen und Schenken</span>
          <nav>
            <Link to="/impressum">Impressum</Link>
            <Link to="/datenschutz">Datenschutz</Link>
            <Link to="/agb">AGB</Link>
            <Link to="/widerruf">Widerruf</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function UserBadge() {
  const me = useQuery(api.users.me, {});
  return <>{me?.email ?? ""}</>;
}

function EditorLink({ active }: { active?: string }) {
  const me = useQuery(api.users.me, {});
  if (!me?.isEditor) return null;
  return (
    <Link to="/admin" className={active}>
      <Icon name="edit" />
      Redaktion
    </Link>
  );
}
