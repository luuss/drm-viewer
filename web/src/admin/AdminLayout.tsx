import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../lib/api";
import FolderImport from "./FolderImport";

/**
 * Rahmen der Redaktion: Hefte, ein Heft, Einstellungen.
 *
 * Der Ordnerimport haengt hier und nicht an der Heftliste. So laeuft ein
 * Import weiter, waehrend die Redaktion schon in ein Heft schaut; ausserhalb
 * der Liste zeigt er nur seinen Balken.
 */
export default function AdminLayout() {
  const me = useQuery(api.users.me, {});
  const loc = useLocation();
  const aufListe = loc.pathname === "/admin" || loc.pathname === "/admin/";

  if (me === undefined) return <div className="centered">Laden...</div>;
  if (!me?.isEditor) {
    return (
      <div className="centered">
        <h2>Kein Zugriff</h2>
        <p>Dieser Bereich ist der Redaktion vorbehalten.</p>
      </div>
    );
  }

  return (
    <div className="page admin">
      <nav className="admin-nav" aria-label="Redaktion">
        <NavLink to="/admin" end>
          Hefte
        </NavLink>
        {me.isAdmin && <NavLink to="/admin/einstellungen">Einstellungen</NavLink>}
      </nav>
      <FolderImport kompakt={!aufListe} />
      <Outlet />
    </div>
  );
}
