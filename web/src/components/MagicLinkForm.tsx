import { useState } from "react";
import { linkAnfordern, type LinkErgebnis } from "../lib/anmeldung";

/**
 * Anmelden ohne Passwort: Adresse eingeben, Link aus der Mail anklicken.
 * Anmelden und Registrieren sind derselbe Weg; das Konto entsteht beim ersten
 * Klick auf den Link. `next` ist die Seite nach der Anmeldung (nur Pfade auf
 * dieser Seite, sonst die Bibliothek).
 */
export default function MagicLinkForm({
  next,
  email: vorbelegt,
}: {
  next?: string;
  /** Adresse vorbelegen, z. B. aus dem Kauf. */
  email?: string;
}) {
  const [email, setEmail] = useState(vorbelegt ?? "");
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<LinkErgebnis | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErgebnis(null);
    setErgebnis(await linkAnfordern(email, next));
    setBusy(false);
  }

  if (ergebnis === "gesendet") {
    return (
      <div className="magic-link-sent inline-auth" role="status">
        <div className="ok">
          Wenn die Adresse stimmt, kommt gleich eine E-Mail an <strong>{email.trim()}</strong>.
        </div>
        <p className="hint">
          Klicken Sie auf den Link in der E-Mail. Er meldet den Browser an, in dem er sich
          öffnet – auf dem Handy also meist den Browser der Mail-App. Der Link gilt 15 Minuten
          und nur einmal. Keine Mail? Auch im Spam-Ordner nachsehen.
        </p>
        <button type="button" className="btn secondary" onClick={() => setErgebnis(null)}>
          Andere Adresse oder neuer Link
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="magic-link-form inline-auth">
      <label>
        E-Mail
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          inputMode="email"
          placeholder="name@beispiel.de"
        />
      </label>
      {ergebnis === "zu_viele" && (
        <div className="err">Zu viele Anfragen. Bitte in einer Stunde noch einmal versuchen.</div>
      )}
      {ergebnis === "adresse" && <div className="err">Bitte eine gültige E-Mail-Adresse eingeben.</div>}
      {ergebnis === "fehler" && (
        <div className="err">Die E-Mail ließ sich gerade nicht senden. Bitte gleich noch einmal versuchen.</div>
      )}
      <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
        {busy ? "..." : "Anmeldelink senden"}
      </button>
      <p className="hint">
        Kein Passwort nötig. Wir schicken Ihnen einen Link, der Sie anmeldet. Neu hier? Dann
        entsteht Ihr Konto mit dem ersten Klick.
      </p>
    </form>
  );
}
