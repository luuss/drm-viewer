import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../lib/api";

const euro = (cents: number) =>
  (cents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

/**
 * Umsatz und Kaeufer. Nur mit der Rolle "Umsatz" (nicht in Admin enthalten).
 * Kaeufe im Leser sind genau; Laden-Kaeufe stehen nur als Freischaltung hier,
 * ihr Betrag ist aus dem Einzelpreis geschaetzt (der echte steht im Laden).
 */
export default function Umsatz() {
  const me = useQuery(api.users.me, {});
  const [jahr, setJahr] = useState<number | undefined>(new Date().getFullYear());
  const daten = useQuery(api.umsatz.uebersicht, me?.siehtUmsatz ? { jahr } : "skip");

  if (me === undefined) return <p className="muted">Laden...</p>;
  if (!me?.siehtUmsatz) {
    return (
      <section>
        <h2>Umsatz</h2>
        <p className="muted">Diese Seite sieht nur, wer die Rolle „Umsatz“ hat.</p>
      </section>
    );
  }
  const jetzt = new Date().getFullYear();
  return (
    <section className="umsatz">
      <h2>Umsatz</h2>
      <label className="muted">
        Zeitraum{" "}
        <select
          value={jahr ?? ""}
          onChange={(e) => setJahr(e.target.value ? Number(e.target.value) : undefined)}
        >
          {[jetzt, jetzt - 1, jetzt - 2].map((j) => (
            <option key={j} value={j}>
              {j}
            </option>
          ))}
          <option value="">Alles</option>
        </select>
      </label>
      {daten === undefined ? (
        <p className="muted">Laden...</p>
      ) : (
        <>
          <div className="umsatz-kacheln">
            <div>
              <span className="muted">Leser (Karte)</span>
              <strong>{euro(daten.summe.leserCents)}</strong>
              <span className="muted">{daten.summe.leserKaeufe} Käufe</span>
            </div>
            <div>
              <span className="muted">Laden (geschätzt)</span>
              <strong>{euro(daten.summe.ladenSchaetzungCents)}</strong>
              <span className="muted">{daten.summe.ladenPositionen} Freischaltungen</span>
            </div>
            <div>
              <span className="muted">Erstattet</span>
              <strong>{euro(daten.summe.erstattetCents)}</strong>
            </div>
            <div>
              <span className="muted">Laufende Abos</span>
              <strong>{daten.abos.leser + daten.abos.laden}</strong>
              <span className="muted">
                {daten.abos.leser} Leser, {daten.abos.laden} Laden
              </span>
            </div>
          </div>
          {daten.test.kaeufe > 0 && (
            <p className="muted">
              Testkäufe (nicht im Umsatz): {daten.test.kaeufe}, {euro(daten.test.cents)}
            </p>
          )}
          <p className="muted">
            Der Laden-Betrag ist aus dem Einzelpreis des Hefts geschätzt; den echten Betrag zeigt
            der Laden. Abos aus dem Laden zählen ohne Betrag.
          </p>

          <h3>Je Monat</h3>
          {daten.monate.length === 0 ? (
            <p className="muted">Noch keine Käufe.</p>
          ) : (
            <table className="tabelle">
              <thead>
                <tr>
                  <th>Monat</th>
                  <th>Leser</th>
                  <th>Käufe</th>
                  <th>Laden (geschätzt)</th>
                  <th>Freischaltungen</th>
                </tr>
              </thead>
              <tbody>
                {daten.monate.map((m) => (
                  <tr key={m.monat}>
                    <td>{m.monat}</td>
                    <td>{euro(m.leserCents)}</td>
                    <td>{m.leserKaeufe}</td>
                    <td>{euro(m.ladenSchaetzungCents)}</td>
                    <td>{m.ladenPositionen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Je Heft</h3>
          {daten.hefte.length === 0 ? (
            <p className="muted">Noch kein Heft verkauft.</p>
          ) : (
            <table className="tabelle">
              <thead>
                <tr>
                  <th>Heft</th>
                  <th>Käufer</th>
                  <th>Leser</th>
                  <th>Laden (geschätzt)</th>
                </tr>
              </thead>
              <tbody>
                {daten.hefte.map((h) => (
                  <tr key={h.issueId}>
                    <td>
                      {h.titel} <span className="muted">{h.reihe}</span>
                    </td>
                    <td>{h.kaeufer}</td>
                    <td>
                      {euro(h.leserCents)} ({h.leserKaeufe})
                    </td>
                    <td>
                      {euro(h.ladenSchaetzungCents)} ({h.ladenPositionen})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Letzte Käufe</h3>
          {daten.letzte.length === 0 ? (
            <p className="muted">Noch keine.</p>
          ) : (
            <table className="tabelle">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Wo</th>
                  <th>Betrag</th>
                  <th>Heft</th>
                  <th>Käufer</th>
                </tr>
              </thead>
              <tbody>
                {daten.letzte.map((k, n) => (
                  <tr key={n}>
                    <td>{new Date(k.zeit).toLocaleString("de-DE")}</td>
                    <td>{k.quelle}</td>
                    <td>
                      {k.betragCents == null ? "—" : euro(k.betragCents)}
                      {k.geschaetzt && k.betragCents != null ? " (geschätzt)" : ""}
                    </td>
                    <td>{k.hefte.join(", ")}</td>
                    <td>{k.kaeufer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
