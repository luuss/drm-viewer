import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { translateAuthError } from "../lib/authError";

export default function LoginPage() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await signIn("password", { email, password, flow: mode });
    } catch (e) {
      setErr(translateAuthError(e, mode));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-box">
        <h1>DRM Reader</h1>
        <p className="subtitle">
          {mode === "signIn" ? "Einloggen" : "Account erstellen"}
        </p>
        <form onSubmit={submit}>
          <label>
            E-Mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Passwort
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            />
          </label>
          {err && <div className="err">{err}</div>}
          <button type="submit" disabled={busy}>
            {busy ? "..." : mode === "signIn" ? "Einloggen" : "Registrieren"}
          </button>
        </form>
        <button
          className="link-btn"
          onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
        >
          {mode === "signIn"
            ? "Noch kein Account? Registrieren"
            : "Schon Account? Einloggen"}
        </button>
      </div>
    </div>
  );
}
