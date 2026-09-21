import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/api";

/** Inhaltsverzeichnis: aus den Artikeln vorbefuellt, von Hand korrigierbar. */
export default function TocEditor({ issueId }: { issueId: Id<"issues"> }) {
  const entries = useQuery(api.toc.listForEditors, { issueId });
  const upsert = useMutation(api.toc.upsert);
  const remove = useMutation(api.toc.remove);

  if (entries === undefined) return <p className="hint">Laden...</p>;

  return (
    <div className="toc-editor">
      {/* Jede Zeile traegt vier Angaben von sehr verschiedener Laenge. Die
          Breiten kommen deshalb aus der Feldskala, nicht aus dem Platz, den
          der Kasten gerade uebrig hat. */}
      <ul className="toc-rows plain">
        {entries.map((e) => (
          <li key={e._id} className="toc-row">
            <input
              className="narrow"
              defaultValue={String(e.order)}
              aria-label="Reihenfolge"
              onBlur={(ev) =>
                upsert({ entryId: e._id, issueId, order: Number(ev.target.value) })
              }
            />
            <input
              defaultValue={e.label}
              aria-label="Beschriftung"
              onBlur={(ev) => upsert({ entryId: e._id, issueId, label: ev.target.value })}
            />
            <input
              className="mid"
              defaultValue={e.section ?? ""}
              placeholder="Rubrik"
              aria-label="Rubrik"
              onBlur={(ev) => upsert({ entryId: e._id, issueId, section: ev.target.value })}
            />
            <input
              className="narrow"
              defaultValue={e.pageIndex !== undefined ? String(e.pageIndex + 1) : ""}
              placeholder="S."
              aria-label="Seite"
              onBlur={(ev) =>
                upsert({
                  entryId: e._id,
                  issueId,
                  pageIndex: Math.max(0, Number(ev.target.value) - 1),
                })
              }
            />
            <button
              className="btn quiet small danger"
              onClick={() => remove({ entryId: e._id })}
            >
              Löschen
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="empty">
            <p>Noch kein Inhalt. Wird beim Import vorbefüllt.</p>
          </li>
        )}
      </ul>
      <button className="btn secondary" onClick={() => upsert({ issueId })}>
        Eintrag hinzufügen
      </button>
    </div>
  );
}
