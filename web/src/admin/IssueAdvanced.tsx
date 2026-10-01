import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../lib/api";
import { useFrage } from "../components/Frage";
import ImportWizard from "./ImportWizard";
import ExtractionDebug from "./ExtractionDebug";
import { MeldungZeile, useMeldung, type EditorIssue } from "./adminUi";

/**
 * Was im Normalfall der Ordnerimport erledigt, hier von Hand: Quellen
 * einzeln ersetzen, Reihenfolge, Auftraege. Dazu die rohe Erkennungsansicht
 * fuer die Fehlersuche und das Loeschen des Hefts.
 */
export default function IssueAdvanced({ issue }: { issue: EditorIssue }) {
  const me = useQuery(api.users.me, {});
  return (
    <div className="heft-erweitert">
      <section className="karte">
        <h3>Quellen und Aufbereitung von Hand</h3>
        <ImportWizard issueId={issue._id} />
      </section>
      <details className="karte aufklapp">
        <summary>Erkennung prüfen (rohe Flächen)</summary>
        <ExtractionDebug issueId={issue._id} />
      </details>
      {me?.isPublisher && <Loeschen issue={issue} />}
    </div>
  );
}

function Loeschen({ issue }: { issue: EditorIssue }) {
  const frage = useFrage();
  const navigate = useNavigate();
  const removeIssue = useMutation(api.issues.remove);
  const [meldung, tue, busy] = useMeldung();
  return (
    <section className="karte gefahr">
      <h3>Ausgabe löschen</h3>
      <p className="hint">
        Entfernt das Heft mit allen Seiten, Artikeln und Dateien. Käufe bleiben bestehen,
        zeigen aber ins Leere.
      </p>
      <button
        className="btn secondary danger"
        disabled={busy !== null}
        onClick={async () => {
          const weiter = await frage({
            titel: "Ausgabe endgültig löschen?",
            text: `„${issue.title}“ verschwindet mit allen Seiten, Artikeln und Dateien. Käufe bleiben bestehen, zeigen aber ins Leere.`,
            ja: "Löschen",
            gefahr: true,
          });
          if (!weiter) return;
          await tue(async () => {
            await removeIssue({ issueId: issue._id });
            navigate("/admin");
          });
        }}
      >
        Ausgabe löschen
      </button>
      <MeldungZeile meldung={meldung} />
    </section>
  );
}
