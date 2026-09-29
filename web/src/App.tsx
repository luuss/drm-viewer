import { useEffect } from "react";
import { Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { AuthLoading, Authenticated, Unauthenticated, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import LoginPage from "./pages/LoginPage";
import LibraryPage from "./library/LibraryPage";
import KioskPage from "./library/KioskPage";
import IssueDetailPage from "./library/IssueDetailPage";
import SubscriptionDetailPage from "./library/SubscriptionDetailPage";
import LinkLoginPage from "./pages/LinkLoginPage";
import { api } from "./lib/api";
import { ABGEMELDET_KEY, geraetName, safeNext } from "./lib/anmeldung";
import ReaderShell from "./reader/ReaderShell";
import AdminPage from "./admin/AdminPage";
import ProfilePage from "./pages/ProfilePage";
import SearchPage from "./pages/SearchPage";
import LegalPage from "./pages/LegalPage";
import AppShell from "./components/AppShell";

export default function App() {
  return (
    <>
      <AuthLoading>
        <div className="centered">Laden...</div>
      </AuthLoading>

      <Unauthenticated>
        <Routes>
          {/* Der Kiosk ist die Startseite: die Hefte sollen ohne Konto sichtbar sein. */}
          <Route path="/" element={<Shell><KioskPage /></Shell>} />
          <Route path="/kiosk" element={<Navigate to="/" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/anmelden" element={<LinkLoginPage />} />
          {/* Alte Einloeselinks aus Kaufmails: die Ausgabe haengt an der Adresse. */}
          <Route path="/claim/:token" element={<Navigate to="/login" replace />} />
          <Route path="/issue/:slug" element={<Shell><IssueDetailPage /></Shell>} />
          <Route path="/abo/:slug" element={<Shell><SubscriptionDetailPage /></Shell>} />
          <Route path="/warenkorb" element={<Navigate to="/" replace />} />
          <Route path="/impressum" element={<Shell><LegalPage doc="impressum" /></Shell>} />
          <Route path="/agb" element={<Shell><LegalPage doc="agb" /></Shell>} />
          <Route path="/widerruf" element={<Shell><LegalPage doc="widerruf" /></Shell>} />
          <Route path="/datenschutz" element={<Shell><LegalPage doc="datenschutz" /></Shell>} />
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </Unauthenticated>

      <Authenticated>
        <Anmeldewaechter />
        <Routes>
          {/* Der Reader laeuft ohne Rahmen, damit die Seite den Schirm fuellt. */}
          <Route path="/reader/:issueId" element={<ReaderShell />} />
          <Route path="/" element={<Shell><KioskPage /></Shell>} />
          <Route path="/kiosk" element={<Navigate to="/" replace />} />
          <Route path="/login" element={<NachAnmeldung />} />
          <Route path="/anmelden" element={<LinkLoginPage />} />
          <Route path="/library" element={<Shell><LibraryPage /></Shell>} />
          <Route path="/issue/:slug" element={<Shell><IssueDetailPage /></Shell>} />
          <Route path="/abo/:slug" element={<Shell><SubscriptionDetailPage /></Shell>} />
          {/* Alte Einloeselinks aus Kaufmails: die Ausgabe haengt an der Adresse. */}
          <Route path="/claim/:token" element={<Navigate to="/login" replace />} />
          <Route path="/warenkorb" element={<Navigate to="/" replace />} />
          <Route path="/suche" element={<Shell><SearchPage /></Shell>} />
          <Route path="/account" element={<Shell><ProfilePage /></Shell>} />
          <Route path="/admin" element={<Shell><AdminPage /></Shell>} />
          <Route path="/impressum" element={<Shell><LegalPage doc="impressum" /></Shell>} />
          <Route path="/agb" element={<Shell><LegalPage doc="agb" /></Shell>} />
          <Route path="/widerruf" element={<Shell><LegalPage doc="widerruf" /></Shell>} />
          <Route path="/datenschutz" element={<Shell><LegalPage doc="datenschutz" /></Shell>} />
          <Route path="*" element={<Navigate to="/library" replace />} />
        </Routes>
      </Authenticated>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

/** Nach der Anmeldung zurueck auf die Seite, von der der Gast kam. */
function NachAnmeldung() {
  const [params] = useSearchParams();
  return <Navigate to={safeNext(params.get("next"))} replace />;
}

/**
 * Beendet ein anderer Browser (dritte Anmeldung) oder die Kontoseite diese
 * Anmeldung, meldet sich dieser Browser sofort ab. Nebenbei merkt sich die
 * Anmeldung einen Geraetenamen fuer die Kontoseite.
 */
function Anmeldewaechter() {
  const status = useQuery(api.sessions.current, {});
  const describe = useMutation(api.sessions.describeCurrent);
  const { signOut } = useAuthActions();

  useEffect(() => {
    describe({ device: geraetName() }).catch(() => {});
  }, [describe]);

  useEffect(() => {
    if (status && !status.alive) {
      localStorage.setItem(ABGEMELDET_KEY, "1");
      void signOut();
    }
  }, [status, signOut]);

  return null;
}
