import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api, cleanError, formatDate, formatEuro } from "../lib/api";
import { useFrage } from "./Frage";

const KAUFSTAND: Record<string, string> = {
  bezahlt: "bezahlt, Bestellung wird angelegt",
  bestellt: "bezahlt",
  fehler: "bezahlt, Freischaltung in Prüfung",
  erstattet: "erstattet",
};

/**
 * Konto: gespeicherte Karte (entfernen), Rechnungsadresse und Kaeufe im
 * Leser. Erscheint nur, wenn der Kartenkauf eingeschaltet ist.
 */
export default function ZahlungsdatenKonto() {
  const status = useQuery(api.leserKasse.status, {});
  const kaeufe = useQuery(api.leserKasse.meineKaeufe, {});
  const entfernen = useAction(api.leserZahlung.karteEntfernen);
  const frage = useFrage();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!status || !status.aktiv) return null;
  const land = (iso: string) => status.laender.find((l) => l.iso === iso)?.name ?? iso;

  return (
    <section>
      <h3>Zahlungsdaten</h3>
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}
      {status.karte ? (
        <div className="kasse-zeile">
          <span>
            Gespeicherte Karte: {status.karte.name}
            {status.karte.ablauf ? `, gültig bis ${status.karte.ablauf}` : ""}
            {status.modus === "test" ? " (Testmodus)" : ""}
          </span>
          <button
            className="btn secondary small danger"
            disabled={busy}
            aria-busy={busy}
            onClick={async () => {
              const ja = await frage({
                titel: "Karte entfernen?",
                text: "Die Karte wird bei Stripe gelöst und nicht mehr für Käufe im Leser verwendet. Beim nächsten Kauf geben Sie sie neu ein.",
                ja: "Karte entfernen",
                gefahr: true,
              });
              if (!ja) return;
              setBusy(true);
              setErr(null);
              setMsg(null);
              try {
                await entfernen({});
                setMsg("Karte entfernt.");
              } catch (e) {
                setErr(cleanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Karte entfernen
          </button>
        </div>
      ) : (
        <p className="hint">Keine Karte gespeichert. Beim nächsten Kauf können Sie eine speichern.</p>
      )}
      {status.adresse && (
        <p className="hint">
          Rechnungsadresse: {status.adresse.vorname} {status.adresse.nachname}
          {status.adresse.firma ? `, ${status.adresse.firma}` : ""}, {status.adresse.strasse},{" "}
          {status.adresse.plz} {status.adresse.ort}, {land(status.adresse.land)}. Ändern beim
          nächsten Kauf.
        </p>
      )}
      {kaeufe && kaeufe.length > 0 && (
        <>
          <h4>Käufe im Leser</h4>
          <ul className="plain">
            {kaeufe.map((k) => (
              <li key={k._id}>
                {formatDate(k.createdAt)} · {k.titel.join(", ")} · {formatEuro(k.betragCents)} ·{" "}
                {KAUFSTAND[k.status] ?? k.status}
                {k.bestellung ? ` · Bestellung ${k.bestellung}` : ""}
                {k.test ? " · Test" : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
