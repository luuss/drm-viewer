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

/** Was ein Zeigerzug gerade tut: neu aufziehen, verschieben oder an einem Griff ziehen. */
type Griff = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type Zug =
  | { art: "neu"; start: { x: number; y: number }; jetzt: { x: number; y: number } }
  | { art: "schieben" | Griff; start: { x: number; y: number }; box: Box };

const GRIFFE: Griff[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN = 0.01;

/** Die Flaeche nach einem Zug an einem Griff oder in der Mitte. */
function verzogen(art: "schieben" | Griff, b: Box, dx: number, dy: number): Box {
  if (art === "schieben") {
    const ddx = Math.max(-b.x0, Math.min(1 - b.x1, dx));
    const ddy = Math.max(-b.y0, Math.min(1 - b.y1, dy));
    return { x0: b.x0 + ddx, x1: b.x1 + ddx, y0: b.y0 + ddy, y1: b.y1 + ddy };
  }
  let { x0, y0, x1, y1 } = b;
  if (art.includes("w")) x0 = Math.min(clamp(x0 + dx), x1 - MIN);
  if (art.includes("e")) x1 = Math.max(clamp(x1 + dx), x0 + MIN);
  if (art.includes("n")) y0 = Math.min(clamp(y0 + dy), y1 - MIN);
  if (art.includes("s")) y1 = Math.max(clamp(y1 + dy), y0 + MIN);
  return { x0, y0, x1, y1 };
}

const prozent = (b: Box) => ({
  left: `${clamp(Math.min(b.x0, b.x1)) * 100}%`,
  top: `${clamp(Math.min(b.y0, b.y1)) * 100}%`,
  width: `${Math.max(0.004, Math.abs(b.x1 - b.x0)) * 100}%`,
  height: `${Math.max(0.004, Math.abs(b.y1 - b.y0)) * 100}%`,
});

/**
 * Eine Seite mit Flaechen darueber. Mit `onZiehen` laesst sich eine neue
 * Flaeche aufziehen; mit `bearbeiten` laesst sich eine gewaehlte Flaeche
 * verschieben und an Ecken und Kanten verziehen. Die Koordinaten sind
 * Anteile der Seite (0 bis 1), wie sie Artikelregionen und Klickflaechen
 * speichern.
 */
export default function Seitenbild({
  seite,
  flaechen,
  onZiehen,
  bearbeiten,
}: {
  seite: Seite | null | undefined;
  flaechen?: Array<Box & { key: string; klasse?: string; titel?: string; onClick?: () => void }>;
  onZiehen?: (box: Box) => void;
  bearbeiten?: { box: Box; onChange: (box: Box) => void };
}) {
  const blatt = useRef<HTMLDivElement>(null);
  const [zug, setZug] = useState<Zug | null>(null);

  if (!seite) return <div className="seitenbild leer" />;

  const punkt = (e: React.PointerEvent) => {
    const r = blatt.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const beginne = (e: React.PointerEvent, art: "schieben" | Griff) => {
    if (!bearbeiten) return;
    e.stopPropagation();
    e.preventDefault();
    blatt.current?.setPointerCapture(e.pointerId);
    setZug({ art, start: punkt(e), box: bearbeiten.box });
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
              setZug({ art: "neu", start: p, jetzt: p });
            }
          : undefined
      }
      onPointerMove={
        zug
          ? (e) => {
              const p = punkt(e);
              if (zug.art === "neu") setZug({ ...zug, jetzt: p });
              else bearbeiten?.onChange(verzogen(zug.art, zug.box, p.x - zug.start.x, p.y - zug.start.y));
            }
          : undefined
      }
      onPointerUp={
        zug
          ? () => {
              setZug(null);
              if (zug.art !== "neu") return;
              const box = {
                x0: Math.min(zug.start.x, zug.jetzt.x),
                y0: Math.min(zug.start.y, zug.jetzt.y),
                x1: Math.max(zug.start.x, zug.jetzt.x),
                y1: Math.max(zug.start.y, zug.jetzt.y),
              };
              if (box.x1 - box.x0 > MIN && box.y1 - box.y0 > MIN) onZiehen?.(box);
            }
          : undefined
      }
      onPointerCancel={() => setZug(null)}
    >
      {seite.previewUrl ? (
        <img src={seite.previewUrl} alt={`Seite ${seite.printedLabel ?? seite.index + 1}`} draggable={false} />
      ) : (
        <div className="seitenbild-fehlt">Vorschau fehlt</div>
      )}
      {flaechen?.map((f) =>
        f.onClick ? (
          <button
            key={f.key}
            type="button"
            className={`flaeche ${f.klasse ?? ""}`}
            style={prozent(f)}
            title={f.titel}
            aria-label={f.titel}
            onClick={f.onClick}
          />
        ) : (
          <span key={f.key} className={`flaeche ${f.klasse ?? ""}`} style={prozent(f)} title={f.titel} />
        ),
      )}
      {bearbeiten && (
        <span
          className="flaeche gewaehlt verziehbar"
          style={prozent(bearbeiten.box)}
          onPointerDown={(e) => beginne(e, "schieben")}
        >
          {GRIFFE.map((g) => (
            <span
              key={g}
              className={`griff-punkt ${g}`}
              onPointerDown={(e) => beginne(e, g)}
            />
          ))}
        </span>
      )}
      {zug?.art === "neu" && (
        <span
          className="flaeche neu"
          style={prozent({ x0: zug.start.x, y0: zug.start.y, x1: zug.jetzt.x, y1: zug.jetzt.y })}
        />
      )}
    </div>
  );
}
