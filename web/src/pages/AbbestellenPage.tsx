import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../lib/api";
import HeftMailWahl from "../components/HeftMailWahl";

/**
 * Abmeldeseite aus den Mails zu neuen Heften (`/abbestellen?t=…&r=<reihe>`).
 * Der Schluessel steht fuer die Adresse, ohne Anmeldung. Abbestellt wird erst
 * mit dem Knopf: Linkpruefer der Mailprogramme oeffnen die Seite auch.
 */
export default function AbbestellenPage() {
  const [params] = useSearchParams();
  const token = params.get("t") ?? "";
  const reihe = params.get("r") ?? "";
  const stand = useQuery(api.heftAnkuendigung.einstellungenMitSchluessel, { token });
  const einstellen = useMutation(api.heftAnkuendigung.einstellenMitSchluessel);
  const [fertig, setFertig] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  if (stand === undefined) return <div className="centered">Laden...</div>;
  if (stand === null) {
    return (
      <div className="page profile">
        <div className="page-head">
          <h2>E-Mails zu neuen Heften</h2>
          <p className="hint">Dieser Link ist nicht mehr gültig.</p>
        </div>
      </div>
    );
  }

  const ziel = stand.reihen.find((r) => r.slug === reihe) ?? null;

  return (
    <div className="page profile">
      <div className="page-head">
        <h2>E-Mails zu neuen Heften</h2>
        <p className="hint">für {stand.adresse}</p>
      </div>

      {ziel && (ziel.erhalten || fertig) && (
        <section>
          {fertig ? (
            <div className="ok" role="status">{fertig}</div>
          ) : (
            <div>
              <button
                className="btn"
                onClick={async () => {
                  setFehler(null);
                  try {
                    await einstellen({ token, publicationId: ziel._id, erhalten: false });
                    setFertig(`„${ziel.name}“ ist abbestellt.`);
                  } catch (e: any) {
                    setFehler(e?.message?.replace(/^\[.*?\]\s*/, "") || "Fehler");
                  }
                }}
              >
                „{ziel.name}“ abbestellen
              </button>
            </div>
          )}
          {fehler && <div className="err" role="alert">{fehler}</div>}
        </section>
      )}

      <section>
        <h3>Zeitschriften</h3>
        <HeftMailWahl
          stand={stand}
          setzen={(publicationId, erhalten) => einstellen({ token, publicationId, erhalten })}
        />
      </section>
    </div>
  );
}
