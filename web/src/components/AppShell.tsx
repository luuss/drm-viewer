import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "../lib/api";
import Icon from "./Icon";
import { useWarenkorb } from "../lib/warenkorb";

const NETZLADEN = "https://lesenundschenken.de/";

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
  const [menuOffen, setMenuOffen] = useState(false);

  // Das Menue schliesst bei jedem Seitenwechsel, sonst bleibt es ueber dem Ziel liegen.
  useEffect(() => setMenuOffen(false), [loc.pathname]);
  useEffect(() => {
    if (!menuOffen) return;
    const taste = (e: KeyboardEvent) => e.key === "Escape" && setMenuOffen(false);
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, [menuOffen]);

  if (embedded) return <main className="embedded">{children}</main>;

  // Der Leser soll ohne Nachdenken sehen, wo er steht; ein Menue ohne Marke
  // fuer die eigene Stelle laesst jede Ansicht gleich aussehen.
  const here = (path: string) => (loc.pathname === path ? "here" : undefined);
  const links = <MenueLinks here={here} adminAktiv={loc.pathname.startsWith("/admin")} pfad={loc.pathname} onAbmelden={() => signOut()} />;

  return (
    <div className="app-shell">
      {/* Kopf wie im Netzladen: eine Zeile, 62 px. Wird es zu eng, klappt die
          Navigation hinter den Menueknopf, statt in eine zweite Zeile umzubrechen. */}
      <header className="app-header">
        <div className="shell-inner">
          <div className="head-left">
            <button
              type="button"
              className="menu-toggle"
              aria-label="Menü"
              aria-expanded={menuOffen}
              aria-controls="nav-drawer"
              onClick={() => setMenuOffen(true)}
            >
              <Icon name="menu" size={22} />
              <span>Menü</span>
            </button>
            <Link to="/" className="brand" aria-label="Lesen und Schenken Digital">
              <img src="/img/lesen-und-schenken.png" alt="Lesen und Schenken" className="brand-logo" />
              <span className="brand-sub">Digital</span>
            </Link>
          </div>
          <nav className="head-nav" aria-label="Hauptnavigation">{links}</nav>
          <div className="head-compact">
            <WarenkorbLink active={here("/warenkorb")} kompakt />
          </div>
        </div>
      </header>

      <div
        id="nav-drawer"
        className={`nav-drawer${menuOffen ? " is-open" : ""}`}
        aria-hidden={!menuOffen}
        onClick={() => setMenuOffen(false)}
      >
        <div className="nav-drawer-panel" role="dialog" aria-label="Menü" onClick={(e) => e.stopPropagation()}>
          <div className="nav-drawer-head">
            <span>Menü</span>
            <button type="button" aria-label="Menü schließen" onClick={() => setMenuOffen(false)}>
              <Icon name="close" size={22} />
            </button>
          </div>
          <nav className="nav-drawer-links" aria-label="Hauptnavigation">{links}</nav>
        </div>
      </div>

      <main>{children}</main>

      <footer className="app-footer">
        <div className="shell-inner footer-main">
          <div className="footer-brand">
            <img src="/img/lesen-und-schenken.png" alt="Lesen und Schenken" className="footer-logo" />
            <ul className="footer-contact">
              <li>
                <span className="label">E-Post</span>
                <a href="mailto:bestellung-netzladen@lesenundschenken.de">
                  bestellung-netzladen@lesenundschenken.de
                </a>
              </li>
              <li>
                <span className="label">Telefon</span>
                <a href="tel:+49438459700">04384 5970-0</a>
              </li>
              <li>
                <span className="label">Fax</span>
                <span>04384 5970-40</span>
              </li>
            </ul>
          </div>
          <nav className="footer-links" aria-label="Hinweise">
            <h4>Hinweise</h4>
            <Link to="/impressum">Impressum</Link>
            <Link to="/datenschutz">Datenschutz</Link>
            <Link to="/agb">AGB</Link>
            <Link to="/widerruf">Vertrag widerrufen</Link>
          </nav>
          <div className="footer-col">
            <h4>Lesen &amp; Schenken Digital</h4>
            <p>
              Die Zeitschriften des Verlags zum Lesen am Bildschirm. Einzelne
              Ausgaben und Digital-Abos gibt es im{" "}
              <a href="https://lesenundschenken.de/" target="_blank" rel="noopener noreferrer">
                Netzladen
              </a>
              , gelesen wird hier auf jedem Gerät.
            </p>
          </div>
        </div>
        <div className="copyright">
          <div className="shell-inner">
            <span>Copyright © {new Date().getFullYear()} Lesen und Schenken GmbH</span>
            <a href="https://lesenundschenken.de/" target="_blank" rel="noopener noreferrer">
              lesenundschenken.de
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Menuepunkte, einmal fuer die Kopfzeile und einmal fuer das Seitenmenue. */
function MenueLinks({
  here,
  adminAktiv,
  pfad,
  onAbmelden,
}: {
  here: (path: string) => string | undefined;
  adminAktiv: boolean;
  pfad: string;
  onAbmelden: () => void;
}) {
  return (
    <>
      <WarenkorbLink active={here("/warenkorb")} />
      <Authenticated>
        <Link to="/library" className={here("/library")}>
          <Icon name="library" /> Meine Ausgaben
        </Link>
      </Authenticated>
      <Link to="/" className={here("/")}>
        <Icon name="kiosk" /> Kiosk
      </Link>
      <Link to="/suche" className={here("/suche")}>
        <Icon name="search" /> Suche
      </Link>
      <Authenticated>
        <EditorLink active={adminAktiv ? "here" : undefined} />
      </Authenticated>
      <a href={NETZLADEN} className="netzladen" title="Zum Netzladen lesenundschenken.de">
        Netzladen <Icon name="external" size={15} />
      </a>
      <Authenticated>
        <Link to="/account" className="user-badge" title="Mein Konto">
          <Icon name="user" />
          <UserBadge />
        </Link>
        <button className="btn secondary small" onClick={onAbmelden}>
          <Icon name="logout" />
          Abmelden
        </button>
      </Authenticated>
      <Unauthenticated>
        <Link
          to={pfad === "/" ? "/login" : `/login?next=${encodeURIComponent(pfad)}`}
          className="btn secondary small"
        >
          <Icon name="login" /> Anmelden
        </Link>
      </Unauthenticated>
    </>
  );
}

/** Nur sichtbar, solange etwas ausgewaehlt ist. */
function WarenkorbLink({ active, kompakt = false }: { active?: string; kompakt?: boolean }) {
  const anzahl = useWarenkorb().length;
  if (anzahl === 0) return null;
  if (kompakt) {
    return (
      <Link to="/warenkorb" className={`cart-compact ${active ?? ""}`.trim()} aria-label={`Warenkorb, ${anzahl}`}>
        <Icon name="cart" size={22} /> <span className="count">{anzahl}</span>
      </Link>
    );
  }
  return (
    <Link to="/warenkorb" className={active}>
      <Icon name="cart" /> Warenkorb <span className="count">{anzahl}</span>
    </Link>
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
