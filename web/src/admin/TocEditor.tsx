import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import { useFrage } from "../components/Frage";
import { useSeiten } from "./Seitenbild";
import { seitenName, SpeicherStand, useFeldSpeicher } from "./adminUi";

/**
 * Inhaltsverzeichnis: aus den Artikeln vorbefuellt, von Hand korrigierbar.
 * Umsortiert wird durch Ziehen (oder mit den Pfeilen), die Ebene ruecken
 * die Pfeile nach links und rechts. Die Seite steht so da, wie sie gedruckt
 * ist; gespeichert wird die Leseseite dazu.
 */
export default function TocEditor({ issueId }: { issueId: Id<"issues"> }) {
  const frage = useFrage();
  const entries = useQuery(api.toc.listForEditors, { issueId });
  const { seiten, labels } = useSeiten(issueId);
  const upsert = useMutation(api.toc.upsert);
  const remove = useMutation(api.toc.remove);
  const reorder = useMutation(api.toc.reorder);
  const [stand, speichere] = useFeldSpeicher();
  const [gezogen, setGezogen] = useState<Id<"tocEntries"> | null>(null);
  const [ueber, setUeber] = useState<Id<"tocEntries"> | null>(null);

  if (entries === undefined) return <p className="hint">Laden...</p>;

  const verschiebe = (von: number, nach: number) => {
    if (von === nach || nach < 0 || nach >= entries.length) return;
    const ids = entries.map((e) => e._id);
    const [id] = ids.splice(von, 1);
    ids.splice(nach, 0, id);
    void speichere(() => reorder({ issueId, orderedIds: ids }));
  };

  /** Gedruckte Seitenzahl oder laufende Nummer zur Leseseite. */
  const leseseite = (eingabe: string): number | undefined => {
    const t = eingabe.trim();
    if (!t) return undefined;
    const treffer = seiten?.find((s) => s.printedLabel === t);
    if (treffer) return treffer.index;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n - 1 : undefined;
  };

  return (
    <div className="toc-editor">
      <div className="review-leiste">
        <span className="hint">{entries.length} Einträge</span>
        <SpeicherStand stand={stand} />
        <button
          className="btn secondary small"
          onClick={() => speichere(() => upsert({ issueId }))}
        >
          Eintrag hinzufügen
        </button>
      </div>
      <ul className="toc-rows plain">
        {entries.map((e, i) => (
          <li
            key={e._id}
            className={`toc-row ebene-${Math.min(3, e.level ?? 1)}${gezogen === e._id ? " gezogen" : ""}${ueber === e._id ? " ueber" : ""}`}
            draggable
            onDragStart={(ev) => {
              setGezogen(e._id);
              ev.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setGezogen(null);
              setUeber(null);
            }}
            onDragOver={(ev) => {
              if (!gezogen) return;
              ev.preventDefault();
              setUeber(e._id);
            }}
            onDrop={(ev) => {
              ev.preventDefault();
              const von = entries.findIndex((x) => x._id === gezogen);
              setGezogen(null);
              setUeber(null);
              if (von >= 0) verschiebe(von, i);
            }}
          >
            <span className="griff" aria-hidden="true" title="Ziehen zum Umsortieren">
              ⋮⋮
            </span>
            <span className="toc-pfeile">
              <button
                className="btn quiet small"
                aria-label="Nach oben"
                title="Nach oben"
                disabled={i === 0}
                onClick={() => verschiebe(i, i - 1)}
              >
                ↑
              </button>
              <button
                className="btn quiet small"
                aria-label="Nach unten"
                title="Nach unten"
                disabled={i === entries.length - 1}
                onClick={() => verschiebe(i, i + 1)}
              >
                ↓
              </button>
              <button
                className="btn quiet small"
                aria-label="Ausrücken"
                title="Ausrücken"
                disabled={(e.level ?? 1) <= 1}
                onClick={() => speichere(() => upsert({ entryId: e._id, issueId, level: (e.level ?? 1) - 1 }))}
              >
                ←
              </button>
              <button
                className="btn quiet small"
                aria-label="Einrücken"
                title="Einrücken"
                disabled={(e.level ?? 1) >= 3}
                onClick={() => speichere(() => upsert({ entryId: e._id, issueId, level: (e.level ?? 1) + 1 }))}
              >
                →
              </button>
            </span>
            <TextFeld
              wert={e.label}
              label="Beschriftung"
              speichere={(label) => speichere(() => upsert({ entryId: e._id, issueId, label }))}
            />
            <TextFeld
              wert={e.section ?? ""}
              label="Rubrik"
              klasse="mid"
              speichere={(section) => speichere(() => upsert({ entryId: e._id, issueId, section }))}
            />
            <TextFeld
              wert={e.pageIndex !== undefined ? seitenName(labels, e.pageIndex) : ""}
              label="Seite"
              klasse="narrow"
              speichere={(t) => {
                const pageIndex = leseseite(t);
                if (pageIndex === undefined) return Promise.resolve();
                return speichere(() => upsert({ entryId: e._id, issueId, pageIndex }));
              }}
            />
            <button
              className="btn quiet small danger"
              onClick={async () => {
                const weiter = await frage({
                  titel: "Eintrag löschen?",
                  text: `„${e.label}“`,
                  ja: "Löschen",
                  gefahr: true,
                });
                if (weiter) await speichere(() => remove({ entryId: e._id }));
              }}
            >
              Löschen
            </button>
          </li>
        ))}
        {entries.length === 0 && (
          <li className="empty">
            <p>Noch kein Inhalt. Er wird bei der Aufbereitung vorbefüllt.</p>
          </li>
        )}
      </ul>
    </div>
  );
}

function TextFeld({
  wert,
  label,
  klasse,
  speichere,
}: {
  wert: string;
  label: string;
  klasse?: string;
  speichere: (wert: string) => Promise<unknown>;
}) {
  return (
    <input
      key={wert}
      className={klasse}
      defaultValue={wert}
      placeholder={label}
      aria-label={label}
      onBlur={(ev) => {
        if (ev.target.value !== wert) void speichere(ev.target.value);
      }}
    />
  );
}

