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
          DRM Reader
        </Link>
        <nav>
          <Authenticated>
            <Link to="/library">Meine Bücher</Link>
            <Link to="/shop">Shop</Link>
            <AdminLink />
            <UserBadge />
            <button className="link-btn" onClick={() => signOut()}>
              Logout
            </button>
          </Authenticated>
          <Unauthenticated>
            <Link to="/shop">Shop</Link>
            <Link to="/">Login</Link>
          </Unauthenticated>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}

function UserBadge() {
  const me = useQuery(api.users.me, {});
  if (!me) return null;
  return <span className="user-badge">{me.email}</span>;
}

function AdminLink() {
  const me = useQuery(api.users.me, {});
  if (!me?.isAdmin) return null;
  return <Link to="/admin">Admin</Link>;
}
