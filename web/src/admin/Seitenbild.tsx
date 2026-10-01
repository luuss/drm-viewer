import { useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";

export type Seite = {
  index: number;
  printedLabel: string | null;
  role: string;
  width: number;
  height: number;
  previewUrl: string | null;
};

/**
 * Seiten eines Hefts fuer die Redaktion, direkt aus der Ablage (ohne
 * Leserfreigabe), dazu die gedruckten Seitenzahlen als Nachschlagetabelle.
 */
export function useSeiten(issueId: Id<"issues">) {
  const rows = useQuery(api.issuePages.debugForEditors, { issueId });
  return useMemo(() => {
    if (rows === undefined) return { seiten: undefined, labels: undefined };
    const seiten: Seite[] = rows.map((p) => ({
      index: p.index,
      printedLabel: p.printedLabel,
      role: p.role,
      width: p.width,
      height: p.height,
      previewUrl: p.previewUrl,
    }));
    const labels = new Map<number, string | null>(seiten.map((s) => [s.index, s.printedLabel]));
    return { seiten, labels };
  }, [rows]);
}

export type Box = { x0: number; y0: number; x1: number; y1: number };

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Eine Seite mit Flaechen darueber. Mit `onZiehen` laesst sich eine neue
 * Flaeche aufziehen; die Koordinaten sind Anteile der Seite (0 bis 1), wie
 * sie Artikelregionen und Klickflaechen speichern.
 */
export default function Seitenbild({
  seite,
  flaechen,
  onZiehen,
}: {
  seite: Seite | null | undefined;
  flaechen?: Array<Box & { key: string; klasse?: string; titel?: string; onClick?: () => void }>;
  onZiehen?: (box: Box) => void;
}) {
  const blatt = useRef<HTMLDivElement>(null);
  const [zug, setZug] = useState<{ start: { x: number; y: number }; jetzt: { x: number; y: number } } | null>(null);

  if (!seite) return <div className="seitenbild leer" />;

  const punkt = (e: React.PointerEvent) => {
    const r = blatt.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  return (
    <div
      ref={blatt}
      className={`seitenbild${onZiehen ? " zeichnen" : ""}`}
      style={{ aspectRatio: `${seite.width || 3} / ${seite.height || 4}` }}
      onPointerDown={
        onZiehen
          ? (e) => {
              if ((e.target as HTMLElement).closest(".flaeche")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = punkt(e);
              setZug({ start: p, jetzt: p });
            }
          : undefined
      }
      onPointerMove={zug ? (e) => setZug({ ...zug, jetzt: punkt(e) }) : undefined}
      onPointerUp={
        zug
          ? () => {
              const box = {
                x0: Math.min(zug.start.x, zug.jetzt.x),
                y0: Math.min(zug.start.y, zug.jetzt.y),
                x1: Math.max(zug.start.x, zug.jetzt.x),
                y1: Math.max(zug.start.y, zug.jetzt.y),
              };
              setZug(null);
              if (box.x1 - box.x0 > 0.01 && box.y1 - box.y0 > 0.01) onZiehen?.(box);
            }
          : undefined
      }
    >
      {seite.previewUrl ? (
        <img src={seite.previewUrl} alt={`Seite ${seite.printedLabel ?? seite.index + 1}`} draggable={false} />
      ) : (
        <div className="seitenbild-fehlt">Vorschau fehlt</div>
      )}
      {flaechen?.map((f) => {
        const stil = {
          left: `${clamp(Math.min(f.x0, f.x1)) * 100}%`,
          top: `${clamp(Math.min(f.y0, f.y1)) * 100}%`,
          width: `${Math.max(0.004, Math.abs(f.x1 - f.x0)) * 100}%`,
          height: `${Math.max(0.004, Math.abs(f.y1 - f.y0)) * 100}%`,
        };
        return f.onClick ? (
          <button
            key={f.key}
            type="button"
            className={`flaeche ${f.klasse ?? ""}`}
            style={stil}
            title={f.titel}
            aria-label={f.titel}
            onClick={f.onClick}
          />
        ) : (
          <span key={f.key} className={`flaeche ${f.klasse ?? ""}`} style={stil} title={f.titel} />
        );
      })}
      {zug && (
        <span
          className="flaeche neu"
          style={{
            left: `${Math.min(zug.start.x, zug.jetzt.x) * 100}%`,
            top: `${Math.min(zug.start.y, zug.jetzt.y) * 100}%`,
            width: `${Math.abs(zug.jetzt.x - zug.start.x) * 100}%`,
            height: `${Math.abs(zug.jetzt.y - zug.start.y) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
