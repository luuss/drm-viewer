import { useMutation } from "convex/react";
import { api, type Id } from "../lib/api";
import { MeldungZeile, useMeldung } from "./adminUi";

/**
 * Veroeffentlichen im Kopf. Gesperrt, solange die Pruefliste etwas offen hat;
 * was fehlt, steht in der Uebersicht.
 */
export default function VeroeffentlichenKnopf({
  issue,
}: {
  issue: { _id: Id<"issues">; isPublished: boolean; pageCount: number; pendingArticles: number };
}) {
  const setPublished = useMutation(api.issues.setPublished);
  const [meldung, tue, busy] = useMeldung();
  const sperre = !issue.pageCount
    ? "Noch keine Seiten"
    : issue.pendingArticles > 0
      ? `${issue.pendingArticles} Artikel offen`
      : null;

  return (
    <div className="veroeffentlichen">
      {issue.isPublished ? (
        <button
          className="btn secondary"
          disabled={busy !== null}
          aria-busy={busy !== null}
          onClick={() =>
            tue(() => setPublished({ issueId: issue._id, isPublished: false }), "Zurückgezogen")
          }
        >
          Zurückziehen
        </button>
      ) : (
        <button
          className="btn"
          disabled={busy !== null || sperre !== null}
          aria-busy={busy !== null}
          title={sperre ?? undefined}
          onClick={() =>
            tue(() => setPublished({ issueId: issue._id, isPublished: true }), "Veröffentlicht")
          }
        >
          Veröffentlichen
        </button>
      )}
      <MeldungZeile meldung={meldung} klein />
    </div>
  );
}
