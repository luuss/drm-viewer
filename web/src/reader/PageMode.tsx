import { useEffect, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { TILE_SERVICE_URL, type Id } from "../lib/api";

type Region = {
  articleId: Id<"articles">;
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type Props = {
  issueId: Id<"issues">;
  pageIndex: number;
  sessionToken: string;
  regions: Region[];
  watermark: string;
  onOpenArticle: (articleId: Id<"articles">) => void;
  onPrev: () => void;
  onNext: () => void;
};

/**
 * Originalgetreue Seite mit Zoom. Die Kacheln kommen vom Gateway, das die
 * Lesesitzung prueft; die Druckdatei selbst verlaesst den Server nie.
 */
export default function PageMode({
  issueId,
  pageIndex,
  sessionToken,
  regions,
  watermark,
  onOpenArticle,
  onPrev,
  onNext,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);

    async function open() {
      const base = `${TILE_SERVICE_URL}/api/issue/${issueId}/page/${pageIndex}`;
      const res = await fetch(`${base}/info`, {
        headers: { "X-Tile-Session": sessionToken },
      });
      if (!res.ok) {
        setError(
          res.status === 409
            ? "Diese Seite ist noch nicht aufbereitet."
            : "Seite konnte nicht geladen werden.",
        );
        return;
      }
      const info = await res.json();
      if (cancelled || !hostRef.current) return;

      viewerRef.current?.destroy();
      viewerRef.current = OpenSeadragon({
        element: hostRef.current,
        showNavigationControl: false,
        gestureSettingsMouse: { clickToZoom: false, scrollToZoom: true },
        gestureSettingsTouch: { pinchToZoom: true, flickEnabled: true },
        visibilityRatio: 1,
        minZoomImageRatio: 0.9,
        maxZoomPixelRatio: 2.5,
        animationTime: 0.4,
        springStiffness: 8,
        loadTilesWithAjax: true,
        ajaxHeaders: { "X-Tile-Session": sessionToken },
        tileSources: {
          width: info.width,
          height: info.height,
          tileSize: info.tileSize,
          minLevel: 0,
          maxLevel: info.maxLevel,
          getTileUrl: (level: number, x: number, y: number) =>
            // Level zaehlt bei OpenSeadragon von grob nach fein; das Gateway
            // erwartet den Verkleinerungsfaktor, also andersherum.
            `${base}/tile/${info.maxLevel - level}/${x}/${y}.jpg`,
        },
      });
      viewerRef.current.addHandler("open", () => setReady(true));
      viewerRef.current.addHandler("tile-load-failed", () =>
        setError("Kacheln konnten nicht geladen werden."),
      );
    }

    void open();
    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [issueId, pageIndex, sessionToken]);

  const pageRegions = regions.filter((r) => r.pageIndex === pageIndex);

  return (
    <div className="page-mode">
      <div className="page-viewer" ref={hostRef} />
      {!ready && !error && <div className="page-hint">Seite wird geladen...</div>}
      {error && <div className="page-hint err">{error}</div>}

      {/* Blaetterzonen am Rand: Tippen wechselt die Seite, Ziehen zoomt. */}
      <button className="page-edge left" onClick={onPrev} aria-label="Vorherige Seite" />
      <button className="page-edge right" onClick={onNext} aria-label="Nächste Seite" />

      <div className="hotspots">
        {pageRegions.map((r, i) => (
          <button
            key={`${r.articleId}-${i}`}
            className="hotspot"
            style={{
              left: `${r.x0 * 100}%`,
              top: `${r.y0 * 100}%`,
              width: `${(r.x1 - r.x0) * 100}%`,
              height: `${(r.y1 - r.y0) * 100}%`,
            }}
            onClick={() => onOpenArticle(r.articleId)}
            aria-label="Artikel öffnen"
          />
        ))}
      </div>

      {watermark && <div className="watermark">{watermark}</div>}
    </div>
  );
}
