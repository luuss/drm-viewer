import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuthActions } from "@convex-dev/auth/react";
import { translateAuthError } from "../lib/authError";

type Mode = "signIn" | "signUp" | "reset" | "reset-verification";

export default function LoginPage() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "reset") {
        await signIn("password", { email, flow: "reset" });
        setInfo("Code verschickt. Bitte E-Mail prüfen.");
        setMode("reset-verification");
      } else if (mode === "reset-verification") {
        await signIn("password", {
          email,
          code,
          newPassword: password,
          flow: "reset-verification",
        });
      } else {
        await signIn("password", { email, password, flow: mode });
      }
    } catch (e) {
      setErr(translateAuthError(e, mode === "signUp" ? "signUp" : "signIn"));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "signIn"
      ? "Einloggen"
      : mode === "signUp"
        ? "Konto erstellen"
        : mode === "reset"
          ? "Passwort zurücksetzen"
          : "Neues Passwort setzen";

  return (
    <div className="auth-page">
      <div className="auth-box">
        <h1>E-Magazin</h1>
        <p className="subtitle">{title}</p>
        <form onSubmit={submit}>
          <label>
            E-Mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={mode === "reset-verification"}
            />
          </label>

          {mode === "reset-verification" && (
            <label>
              Code aus der E-Mail
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </label>
          )}

          {mode !== "reset" && (
            <label>
              {mode === "reset-verification" ? "Neues Passwort" : "Passwort"}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={10}
                autoComplete={
                  mode === "signIn" ? "current-password" : "new-password"
                }
              />
            </label>
          )}

          {mode !== "signIn" && mode !== "reset" && (
            <p className="hint">
              Mindestens 10 Zeichen, mit Buchstaben und Ziffern.
            </p>
          )}

          {err && <div className="err">{err}</div>}
          {info && <div className="ok">{info}</div>}
          <button type="submit" disabled={busy}>
            {busy
              ? "..."
              : mode === "signIn"
                ? "Einloggen"
                : mode === "signUp"
                  ? "Registrieren"
                  : mode === "reset"
                    ? "Code anfordern"
                    : "Passwort speichern"}
          </button>
        </form>

        <div className="auth-links">
          {mode === "signIn" && (
            <>
              <button className="link-btn" onClick={() => setMode("signUp")}>
                Noch kein Konto? Registrieren
              </button>
              <button className="link-btn" onClick={() => setMode("reset")}>
                Passwort vergessen
              </button>
            </>
          )}
          {mode !== "signIn" && (
            <button className="link-btn" onClick={() => setMode("signIn")}>
              Zurück zum Login
            </button>
          )}
        </div>

        <p className="legal-line">
          <Link to="/impressum">Impressum</Link> ·{" "}
          <Link to="/datenschutz">Datenschutz</Link> ·{" "}
          <Link to="/agb">AGB</Link>
        </p>
      </div>
    </div>
  );
}
