import { useEffect, useRef, useState } from "react";

type Props = {
  mode: "page" | "article";
  position: number;
  total: number;
  label: string;
  onSeek: (position: number) => void;
};

/**
 * Untere Leiste. Sie zeigt im Seitenmodus Seiten und im Artikelmodus Artikel —
 * derselbe Regler, andere Bedeutung. Beim Ziehen laeuft die Anzeige mit, der
 * Sprung passiert erst beim Loslassen.
 */
export default function ReaderRail({ mode, position, total, label, onSeek }: Props) {
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => setDragging(null), [position]);
  const regler = useRef<HTMLInputElement>(null);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  // Ein Sprung je Loslassen: `change`, `pointerup` und die Tastatur koennen
  // kurz hintereinander denselben Wert melden.
  const zuletzt = useRef<{ wert: number; zeit: number } | null>(null);
  const springen = (wert: number) => {
    const jetzt = Date.now();
    const z = zuletzt.current;
    if (z && z.wert === wert && jetzt - z.zeit < 400) return;
    zuletzt.current = { wert, zeit: jetzt };
    setDragging(null);
    onSeekRef.current(wert);
  };
  const springenRef = useRef(springen);
  springenRef.current = springen;

  // Das native `change` kommt in jedem Browser beim Loslassen, auch mit dem
  // Finger auf iOS, wo `pointerup` am Fenster nicht verlaesslich ankommt.
  useEffect(() => {
    const el = regler.current;
    if (!el) return;
    const beimLoslassen = () => springenRef.current(Number(el.value));
    el.addEventListener("change", beimLoslassen);
    return () => el.removeEventListener("change", beimLoslassen);
  }, []);

  // Das Loslassen wird am Fenster abgehoert, nicht am Regler. Wer beim Ziehen
  // den Regler verlaesst und die Taste woanders loslaesst, bekam sonst keinen
  // Sprung: die Anzeige stand auf der neuen Seite, der Reader auf der alten.
  useEffect(() => {
    if (dragging === null) return;
    const commit = () => springenRef.current(dragging);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", commit);
    return () => {
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", commit);
    };
  }, [dragging]);

  const shown = dragging ?? position;
  return (
    <div className="reader-rail">
      <span className="rail-label">
        {mode === "page" ? "Seite" : "Artikel"} {shown + 1} / {Math.max(total, 1)}
      </span>
      {/* Zaehler und Titel stehen getrennt: der Zaehler haelt eine feste
          Breite, sonst wandert der Regler bei jedem Blaettern seitwaerts. */}
      {label && <span className="rail-title">{label}</span>}
      <input
        ref={regler}
        type="range"
        min={0}
        max={Math.max(0, total - 1)}
        value={shown}
        onChange={(e) => setDragging(Number(e.target.value))}
        onKeyUp={(e) => {
          // Mit der Tastatur gibt es kein Loslassen des Zeigers; hier wird der
          // Sprung deshalb direkt nach dem Tastendruck ausgeloest.
          const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
          if (keys.includes(e.key) && dragging !== null) {
            springen(dragging);
          }
        }}
        aria-label={mode === "page" ? "Seite wählen" : "Artikel wählen"}
      />
    </div>
  );
}
