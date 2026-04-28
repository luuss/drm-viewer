import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { Authenticated, Unauthenticated } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../lib/convex";
import { translateAuthError } from "../lib/authError";

export default function ClaimPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const info = useQuery(api.claims.lookup, { token: token! });
  const claim = useMutation(api.claims.claim);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (info === undefined) return <div className="centered">Laden...</div>;

  if (info.status === "invalid") {
    return (
      <div className="centered">
        <h2>Ungültiger Link</h2>
        <p>Der Claim-Link ist nicht bekannt.</p>
      </div>
    );
  }
  if (info.status === "expired") {
    return (
      <div className="centered">
        <h2>Link abgelaufen</h2>
        <p>Bitte wende dich an den Support.</p>
      </div>
    );
  }
  if (info.status === "already_claimed") {
    return (
      <div className="centered">
        <h2>Bereits eingelöst</h2>
        <p>Dieser Link wurde schon verwendet.</p>
      </div>
    );
  }

  async function doClaim() {
    setErr(null);
    setBusy(true);
    try {
      const r = await claim({ token: token! });
      navigate(`/read/${r.bookId}`);
    } catch (e: any) {
      setErr(e.message || "Einlösen fehlgeschlagen");
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="claim-box">
        <h2>Buch freischalten</h2>
        {info.book && (
          <div className="book-preview">
            {info.book.coverUrl ? (
              <img src={info.book.coverUrl} alt={info.book.title} />
            ) : (
              <div className="cover-placeholder">{info.book.title[0]}</div>
            )}
            <div className="title">{info.book.title}</div>
          </div>
        )}
        <p className="hint">
          Kaufbestätigung für <strong>{info.email}</strong>
        </p>

        <Authenticated>
          <p className="hint">
            Das Buch wird mit deinem Account verknüpft und ist danach dauerhaft
            in deiner Bibliothek.
          </p>
          <button className="btn" onClick={doClaim} disabled={busy}>
            {busy ? "..." : "Jetzt freischalten"}
          </button>
          {err && <div className="err">{err}</div>}
        </Authenticated>

        <Unauthenticated>
          <p className="hint">
            Logge dich ein oder erstelle einen Account, um das Buch zu deiner
            Bibliothek hinzuzufügen. Der Link ist einmalig einlösbar —
            geteilte Links funktionieren danach nicht mehr.
          </p>
          <InlineAuth defaultEmail={info.email} onDone={doClaim} />
          {err && <div className="err">{err}</div>}
        </Unauthenticated>
      </div>
    </div>
  );
}

function InlineAuth({
  defaultEmail,
  onDone,
}: {
  defaultEmail: string;
  onDone: () => void;
}) {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await signIn("password", { email, password, flow: mode });
      setTimeout(onDone, 200);
    } catch (e: any) {
      setErr(e.message || "Fehler");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="inline-auth">
      <label>
        E-Mail
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
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
        />
      </label>
      <button type="submit" disabled={busy} className="btn">
        {busy ? "..." : mode === "signIn" ? "Einloggen & einlösen" : "Account erstellen & einlösen"}
      </button>
      <button
        type="button"
        className="link-btn"
        onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
      >
        {mode === "signIn" ? "Account erstellen" : "Schon registriert? Einloggen"}
      </button>
      {err && <div className="err">{err}</div>}
    </form>
  );
}
