import { useState } from "react";
import type { Id } from "../lib/api";

export type HeftMailStand = {
  alleAbbestellt: boolean;
  reihen: { _id: Id<"publications">; name: string; slug: string; erhalten: boolean }[];
};

/**
 * Welche Zeitschriften Mails zu neuen Heften schicken: je Reihe ein Haken,
 * dazu "alle abbestellen". Gemeinsam fuer die Abmeldeseite aus der Mail und
 * die Kontoseite; `setzen` ohne Reihe gilt fuer alle.
 */
export default function HeftMailWahl({
  stand,
  setzen,
}: {
  stand: HeftMailStand;
  setzen: (publicationId: Id<"publications"> | undefined, erhalten: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ art: "ok" | "err"; text: string } | null>(null);

  async function aendern(publicationId: Id<"publications"> | undefined, erhalten: boolean, ok: string) {
    setBusy(true);
    setMeldung(null);
    try {
      await setzen(publicationId, erhalten);
      setMeldung({ art: "ok", text: ok });
    } catch (e: any) {
      setMeldung({ art: "err", text: e?.message?.replace(/^\[.*?\]\s*/, "") || "Fehler" });
    } finally {
      setBusy(false);
    }
  }

  const irgendeine = stand.reihen.some((r) => r.erhalten);

  return (
    <div className="heftmail-wahl">
      <ul className="plain heftmail-reihen">
        {stand.reihen.map((r) => (
          <li key={r._id}>
            <label>
              <input
                type="checkbox"
                checked={r.erhalten}
                disabled={busy}
                onChange={(e) =>
                  aendern(
                    r._id,
                    e.target.checked,
                    e.target.checked ? `Mails zu „${r.name}“ bestellt.` : `„${r.name}“ abbestellt.`,
                  )
                }
              />
              {r.name}
            </label>
          </li>
        ))}
      </ul>
      {irgendeine && (
        <button
          className="btn secondary small"
          disabled={busy}
          onClick={() => aendern(undefined, false, "Alle Mails zu neuen Heften abbestellt.")}
        >
          Alle abbestellen
        </button>
      )}
      {meldung && (
        <div className={meldung.art} role={meldung.art === "err" ? "alert" : "status"}>
          {meldung.text}
        </div>
      )}
    </div>
  );
}
