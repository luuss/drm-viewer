import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/api";

/** Inhaltsverzeichnis: aus den Artikeln vorbefuellt, von Hand korrigierbar. */
export default function TocEditor({ issueId }: { issueId: Id<"issues"> }) {
  const entries = useQuery(api.toc.listForEditors, { issueId });
  const upsert = useMutation(api.toc.upsert);
  const remove = useMutation(api.toc.remove);

  if (entries === undefined) return <p>Laden...</p>;

  return (
    <div className="toc-editor">
      <ul className="plain">
        {entries.map((e) => (
          <li key={e._id}>
            <input
              defaultValue={String(e.order)}
              size={3}
              onBlur={(ev) =>
                upsert({ entryId: e._id, issueId, order: Number(ev.target.value) })
              }
            />
            <input
              defaultValue={e.label}
              onBlur={(ev) => upsert({ entryId: e._id, issueId, label: ev.target.value })}
            />
            <input
              defaultValue={e.section ?? ""}
              placeholder="Rubrik"
              size={12}
              onBlur={(ev) => upsert({ entryId: e._id, issueId, section: ev.target.value })}
            />
            <input
              defaultValue={e.pageIndex !== undefined ? String(e.pageIndex + 1) : ""}
              placeholder="Seite"
              size={4}
              onBlur={(ev) =>
                upsert({
                  entryId: e._id,
                  issueId,
                  pageIndex: Math.max(0, Number(ev.target.value) - 1),
                })
              }
            />
            <button className="link-btn danger" onClick={() => remove({ entryId: e._id })}>
              löschen
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="hint">Noch kein Inhalt. Wird beim Import vorbefüllt.</li>
        )}
      </ul>
      <button className="link-btn" onClick={() => upsert({ issueId })}>
        Eintrag hinzufügen
      </button>
    </div>
  );
}
