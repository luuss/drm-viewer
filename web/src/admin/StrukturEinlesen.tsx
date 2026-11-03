import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../lib/api";
import { alleDateien, strukturLesen } from "./folderDrop";
import {
  HEFTARCHIV_EREIGNIS,
  MUSTERHEFTE,
  fertigeHefte,
  fertigVergessen,
  hefteImArchiv,
  type ArchivHeft,
} from "./heftarchiv";
import { formatBytes } from "./folderScan";

type Stand =
  | { art: "leer" }
  | { art: "liest"; dateien: number; bytes: number }
  | { art: "laedt"; dateien: number; bytes: number }
  | { art: "fertig"; dateien: number; bytes: number; key: string }
  | { art: "fehler"; text: string };

/**
 * Vor dem Massenimport: das ganze Heftarchiv fallen lassen, hochgeladen wird
 * nur die Liste der Dateien (Pfad, Groesse, Datum). Kein Heft wird angelegt,
 * keine Heftdatei verlaesst den Rechner. Aus der Liste sucht die Technik je
 * Reihe Musterhefte heraus und baut den Massenimport.
 */
export default function StrukturEinlesen() {
  const presign = useAction(api.uploads.presignStruktur);
  const [stand, setStand] = useState<Stand>({ art: "leer" });
  const [ueber, setUeber] = useState(false);
  const laeuft = stand.art === "liest" || stand.art === "laedt";

  async function einlesen(items: DataTransferItemList) {
    try {
      setStand({ art: "liest", dateien: 0, bytes: 0 });
      const liste = await strukturLesen(items, (dateien, bytes) =>
        setStand({ art: "liest", dateien, bytes }),
      );
      if (!liste.dateien.length) {
        setStand({ art: "fehler", text: "Im Ordner lagen keine Dateien." });
        return;
      }
      setStand({ art: "laedt", dateien: liste.dateien.length, bytes: liste.bytes });
      const blob = new Blob(
        [JSON.stringify({ version: 1, erstellt: new Date().toISOString(), ...liste })],
        { type: "application/json" },
      );
      const ziel = await presign({ name: liste.wurzeln[0] ?? "ordner", bytes: blob.size });
      if (!ziel) throw new Error("Kein Medienspeicher eingerichtet");
      const put = await fetch(ziel.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: blob,
      });
      if (!put.ok) throw new Error(`Hochladen abgelehnt (${put.status})`);
      setStand({ art: "fertig", dateien: liste.dateien.length, bytes: liste.bytes, key: ziel.key });
    } catch (e: any) {
      setStand({ art: "fehler", text: e?.message ?? String(e) });
    }
  }

  return (
    <>
      <ArchivImport />
    <details className="aufklapp struktur-einlesen">
      <summary>Ordnerstruktur einlesen (nur Liste, für den Massenimport)</summary>
      <div
        className={`dropzone${ueber ? " over" : ""}${laeuft ? " busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!laeuft) setUeber(true);
        }}
        onDragLeave={() => setUeber(false)}
        onDrop={(e) => {
          e.preventDefault();
          setUeber(false);
          if (!laeuft) void einlesen(e.dataTransfer.items);
        }}
        aria-disabled={laeuft}
      >
        <strong>Ganzes Heftarchiv hierher ziehen</strong>
        <span className="hint">
          Gelesen werden nur Ordner, Dateinamen und Größen. Keine Heftdatei wird hochgeladen
          und kein Heft angelegt.
        </span>
      </div>
      {stand.art === "liest" && (
        <p className="muted" role="status">
          Lese Ordner … {stand.dateien.toLocaleString("de-DE")} Dateien, {formatBytes(stand.bytes)}
        </p>
      )}
      {stand.art === "laedt" && (
        <p className="muted" role="status">
          Lade die Liste hoch ({stand.dateien.toLocaleString("de-DE")} Dateien) …
        </p>
      )}
      {stand.art === "fertig" && (
        <p role="status">
          Fertig: {stand.dateien.toLocaleString("de-DE")} Dateien, {formatBytes(stand.bytes)}{" "}
          im Archiv. Die Liste liegt unter <code>{stand.key}</code>.
        </p>
      )}
      {stand.art === "fehler" && <p className="err">Fehler: {stand.text}</p>}
    </details>
    </>
  );
}

/**
 * Hefte aus dem ganzen Heftarchiv importieren. Der Browser findet die Hefte
 * selbst (`hefteImArchiv`) und gibt nur sie an die Importschlange; von jedem
 * Heft liest der Import nur, was er braucht (Innenteil, Umschlag, IDML,
 * Bilder aus Links/), nicht das ganze Archiv.
 */
function ArchivImport() {
  const [ueber, setUeber] = useState(false);
  const [liest, setLiest] = useState<number | null>(null);
  const [nurMuster, setNurMuster] = useState(true);
  const [gefunden, setGefunden] = useState<ArchivHeft[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [gestartet, setGestartet] = useState(0);

  async function lesen(items: DataTransferItemList) {
    setFehler(null);
    setGefunden(null);
    setGestartet(0);
    try {
      setLiest(0);
      const dateien = await alleDateien(items, (n) => setLiest(n));
      setGefunden(hefteImArchiv(dateien));
    } catch (e: any) {
      setFehler(e?.message ?? String(e));
    } finally {
      setLiest(null);
    }
  }

  const [ohneFertige, setOhneFertige] = useState(true);
  const fertig = gefunden ? fertigeHefte() : new Set<string>();
  const auswahl = (gefunden ?? [])
    .filter((h) => !nurMuster || MUSTERHEFTE.includes(h.kennung))
    .filter((h) => !ohneFertige || !fertig.has(h.folderName));
  const schonFertig = (gefunden ?? []).filter((h) => fertig.has(h.folderName)).length;
  const fehlen = nurMuster && gefunden
    ? MUSTERHEFTE.filter((k) => !gefunden.some((h) => h.kennung === k))
    : [];

  function starten() {
    window.dispatchEvent(
      new CustomEvent(HEFTARCHIV_EREIGNIS, {
        detail: auswahl.map((h) => ({ folderName: h.folderName, files: h.files })),
      }),
    );
    setGestartet(auswahl.length);
  }

  return (
    <details className="aufklapp struktur-einlesen">
      <summary>Hefte aus dem Heftarchiv importieren</summary>
      <div
        className={`dropzone${ueber ? " over" : ""}${liest !== null ? " busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (liest === null) setUeber(true);
        }}
        onDragLeave={() => setUeber(false)}
        onDrop={(e) => {
          e.preventDefault();
          setUeber(false);
          if (liest === null) void lesen(e.dataTransfer.items);
        }}
      >
        <strong>Ganzes Heftarchiv hierher ziehen</strong>
        <span className="hint">
          Der Browser sucht die Hefte selbst heraus. Hochgeladen wird je Heft nur Innenteil,
          Umschlag, IDML und die Bilder in Netzgröße.
        </span>
      </div>
      <label className="muted">
        <input
          type="checkbox"
          checked={nurMuster}
          onChange={(e) => setNurMuster(e.target.checked)}
        />{" "}
        Nur die {MUSTERHEFTE.length} Musterhefte
      </label>
      <label className="muted">
        <input
          type="checkbox"
          checked={ohneFertige}
          onChange={(e) => setOhneFertige(e.target.checked)}
        />{" "}
        Schon importierte überspringen{schonFertig ? ` (${schonFertig})` : ""}{" "}
        <button
          type="button"
          className="btn quiet small"
          onClick={() => {
            fertigVergessen();
            setGefunden(gefunden ? [...gefunden] : null);
          }}
        >
          Liste leeren
        </button>
      </label>
      {liest !== null && (
        <p className="muted" role="status">
          Lese Archiv … {liest.toLocaleString("de-DE")} Dateien
        </p>
      )}
      {fehler && <p className="err">Fehler: {fehler}</p>}
      {gefunden && (
        <div>
          <p>
            {gefunden.length} Hefte im Archiv gefunden ({gefunden.filter((h) => h.mitIdml).length}{" "}
            mit IDML). Ausgewählt: {auswahl.length}.
            {fehlen.length > 0 && <> Nicht gefunden: {fehlen.join(", ")}.</>}
          </p>
          <ul className="muted heftarchiv-liste">
            {auswahl.slice(0, 60).map((h) => (
              <li key={h.pfad}>
                {h.kennung} · {h.mitIdml ? "IDML + PDF" : "nur PDF"} · {h.pfad}
              </li>
            ))}
            {auswahl.length > 60 && <li>… und {auswahl.length - 60} weitere</li>}
          </ul>
          {gestartet > 0 ? (
            <p role="status">{gestartet} Hefte sind in der Importschlange. Der Balken oben zeigt den Lauf.</p>
          ) : (
            <button type="button" onClick={starten} disabled={!auswahl.length}>
              {auswahl.length} Hefte importieren
            </button>
          )}
        </div>
      )}
    </details>
  );
}
