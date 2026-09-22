import { useState } from "react";
import { useFrage } from "../components/Frage";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, formatEuro } from "../lib/api";

/** Der Zahlungsdienst liefert die Zustaende englisch; im Konto stehen sie
 *  deutsch. */
const KAUFSTATUS: Record<string, string> = {
  pending: "in Bearbeitung",
  paid: "bezahlt",
  failed: "fehlgeschlagen",
  refunded: "erstattet",
};

export default function ProfilePage() {
  const frage = useFrage();
  const me = useQuery(api.users.me, {});
  const subStatus = useQuery(api.subscriptions.myStatus, {});
  const purchases = useQuery(api.purchases.mine, {});
  const sessions = useQuery(api.readerSessions.mine, {});
  const changePassword = useAction(api.account.changePassword);
  const deleteAccount = useAction(api.account.deleteMyAccount);
  const portal = useAction(api.billing.createPortalSession);
  const cancelSub = useAction(api.billing.cancelMySubscription);
  const revokeSessions = useMutation(api.readerSessions.revokeAllMine);
  const setName = useMutation(api.account.setName);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [name, setNameValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me === undefined) return <div className="centered">Laden...</div>;
  if (me === null) return <div className="centered">Nicht eingeloggt</div>;

  async function guard(fn: () => Promise<void>) {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message?.replace(/^\[.*?\]\s*/, "") || "Fehler");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page profile">
      <div className="page-head">
        <h2>Profil</h2>
        <p className="hint">
          Angemeldet als <strong>{me.email}</strong>
          {me.emailVerified ? " · E-Mail bestätigt" : " · E-Mail nicht bestätigt"}
        </p>
      </div>

      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}

      <section>
        <h3>Abo</h3>
        {subStatus?.active ? (
          <ul className="plain">
            {subStatus.subscriptions.map((s) => (
              <li key={s._id} className="sub-line">
                <span>
                  Status {s.status}
                  {s.currentPeriodEnd
                    ? ` · läuft bis ${new Date(s.currentPeriodEnd).toLocaleDateString("de-DE")}`
                    : ""}
                  {s.cancelAtPeriodEnd ? " · gekündigt zum Laufzeitende" : ""}
                </span>
                {!s.cancelAtPeriodEnd && (
                  <button
                    className="btn secondary small"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        await cancelSub({
                          stripeSubscriptionId: s.stripeSubscriptionId,
                        });
                        setMsg("Kündigung zum Laufzeitende vorgemerkt.");
                      })
                    }
                  >
                    Kündigen
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Kein laufendes Abo.</p>
        )}
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() =>
            guard(async () => {
              const { url } = await portal({
                returnUrl: `${window.location.origin}/account`,
              });
              window.location.href = url;
            })
          }
        >
          Zahlungen und Rechnungen verwalten
        </button>
      </section>

      <section>
        <h3>Name</h3>
        <form
          className="inline-form short"
          onSubmit={(e) => {
            e.preventDefault();
            guard(async () => {
              await setName({ name });
              setMsg("Name gespeichert.");
            });
          }}
        >
          <input
            value={name}
            placeholder={me.name ?? "Anzeigename"}
            onChange={(e) => setNameValue(e.target.value)}
            aria-label="Anzeigename"
          />
          <button className="btn" disabled={busy || !name.trim()}>
            Speichern
          </button>
        </form>
      </section>

      <section>
        <h3>Passwort ändern</h3>
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            guard(async () => {
              await changePassword({
                currentPassword: current,
                newPassword: next,
              });
              setCurrent("");
              setNext("");
              setMsg("Passwort geändert. Andere Geräte wurden abgemeldet.");
            });
          }}
        >
          <label>
            Aktuelles Passwort
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <label>
            Neues Passwort
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
            />
          </label>
          <button className="btn" disabled={busy}>
            Passwort ändern
          </button>
        </form>
      </section>

      <section>
        <h3>Aktive Lesesitzungen</h3>
        {sessions && sessions.length > 0 ? (
          <>
            <ul className="session-list">
              {sessions.map((s) => (
                <li key={s._id}>
                  {s.issueTitle} · seit{" "}
                  {new Date(s.createdAt).toLocaleString("de-DE")} · {s.tileCount}{" "}
                  Kacheln
                </li>
              ))}
            </ul>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() =>
                guard(async () => {
                  const n = await revokeSessions({});
                  setMsg(`${n} Sitzungen beendet.`);
                })
              }
            >
              Alle Sitzungen beenden
            </button>
          </>
        ) : (
          <p className="hint">Keine offenen Sitzungen.</p>
        )}
      </section>

      <section>
        <h3>Käufe</h3>
        {purchases && purchases.length > 0 ? (
          <ul className="plain">
            {purchases.map((p) => (
              <li key={p._id}>
                {new Date(p.createdAt).toLocaleDateString("de-DE")} ·{" "}
                {p.title ?? p.planName ?? "Position"} · {formatEuro(p.amountCents)} ·{" "}
                {KAUFSTATUS[p.status] ?? p.status}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Noch keine Käufe.</p>
        )}
      </section>

      <section>
        <h3>Konto löschen</h3>
        <p className="hint">
          Löscht Konto, Freischaltungen und Lesefortschritt. Rechnungsbelege
          bleiben beim Zahlungsdienstleister gespeichert. Ein laufendes Abo
          bitte vorher kündigen.
        </p>
        <button
          className="btn secondary danger"
          disabled={busy}
          onClick={async () => {
            const weiter = await frage({
              titel: "Konto endgültig löschen?",
              text: "Zugang, Freischaltungen und Lesefortschritt verschwinden. Das lässt sich nicht rückgängig machen.",
              ja: "Konto löschen",
              gefahr: true,
            });
            if (!weiter) return;
            guard(async () => {
              await deleteAccount({ confirm: "LOESCHEN" });
              window.location.href = "/";
            });
          }}
        >
          Konto endgültig löschen
        </button>
      </section>
    </div>
  );
}
