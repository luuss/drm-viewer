import { Routes, Route, Navigate } from "react-router-dom";
import { AuthLoading, Authenticated, Unauthenticated } from "convex/react";
import LoginPage from "./pages/LoginPage";
import LibraryPage from "./library/LibraryPage";
import KioskPage from "./library/KioskPage";
import IssueDetailPage from "./library/IssueDetailPage";
import ClaimPage from "./pages/ClaimPage";
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
          <Route path="/claim/:token" element={<ClaimPage />} />
          <Route path="/kiosk" element={<Shell><KioskPage /></Shell>} />
          <Route path="/issue/:slug" element={<Shell><IssueDetailPage /></Shell>} />
          <Route path="/impressum" element={<Shell><LegalPage doc="impressum" /></Shell>} />
          <Route path="/agb" element={<Shell><LegalPage doc="agb" /></Shell>} />
          <Route path="/widerruf" element={<Shell><LegalPage doc="widerruf" /></Shell>} />
          <Route path="/datenschutz" element={<Shell><LegalPage doc="datenschutz" /></Shell>} />
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </Unauthenticated>

      <Authenticated>
        <Routes>
          {/* Der Reader laeuft ohne Rahmen, damit die Seite den Schirm fuellt. */}
          <Route path="/reader/:issueId" element={<ReaderShell />} />
          <Route path="/" element={<Navigate to="/library" replace />} />
          <Route path="/library" element={<Shell><LibraryPage /></Shell>} />
          <Route path="/kiosk" element={<Shell><KioskPage /></Shell>} />
          <Route path="/issue/:slug" element={<Shell><IssueDetailPage /></Shell>} />
          <Route path="/claim/:token" element={<ClaimPage />} />
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
