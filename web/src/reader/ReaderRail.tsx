import { useEffect, useState } from "react";

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

  const shown = dragging ?? position;
  return (
    <div className="reader-rail">
      <span className="rail-label">
        {mode === "page" ? "Seite" : "Artikel"} {shown + 1} / {Math.max(total, 1)}
        {label ? ` · ${label}` : ""}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(0, total - 1)}
        value={shown}
        onChange={(e) => setDragging(Number(e.target.value))}
        onMouseUp={() => dragging !== null && onSeek(dragging)}
        onTouchEnd={() => dragging !== null && onSeek(dragging)}
        onKeyUp={(e) => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key) && dragging !== null) {
            onSeek(dragging);
          }
        }}
        aria-label={mode === "page" ? "Seite wählen" : "Artikel wählen"}
      />
    </div>
  );
}
