import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../lib/api";
import { strukturLesen } from "./folderDrop";
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
  );
}
