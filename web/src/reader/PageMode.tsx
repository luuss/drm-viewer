import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
 * Wartezeit, bevor eine Seite wirklich geholt wird. Wer schnell blaettert oder
 * den Regler zieht, laeuft sonst in die Ratenbegrenzung des Gateways: jede
 * Zwischenseite kostete eine Anfrage, nach achtzig Seiten je Minute kam nur
 * noch 429 zurueck und die Seitenansicht blieb leer, bis die Minute um war.
 */
const SETTLE_MS = 180;

/** Nach einer Ratenbegrenzung wird von selbst noch einmal versucht. */
const RETRY_MS = 2500;
const MAX_RETRIES = 4;

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
  const layerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Spiegel von `ready` fuer die Ereignisbehandlung von OpenSeadragon, die
  // ausserhalb des Renderlaufs feuert und den Zustand sonst veraltet sieht.
  const readyRef = useRef(false);
  // Die Klickflaechen haengen in der Leinwand von OpenSeadragon, nicht darueber.
  // Nur so kommen Mausrad und Ziehen beim Betrachter an: liegt eine Flaeche
  // ueber der Seite, schluckte sie sonst das Rad und der Zoom blieb aus.
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  // Die Ereignisbehandlung von OpenSeadragon wird einmal angemeldet, die
  // Klickflaechen wechseln aber mit jeder Seite. Darum liegen sie in Verweisen.
  const regionsRef = useRef<Region[]>([]);
  const openArticleRef = useRef(onOpenArticle);
  openArticleRef.current = onOpenArticle;

  /**
   * Die Klickflaechen liegen normiert auf der Seite, nicht auf dem Fenster.
   * OpenSeadragon setzt die Seite mittig und mit ihrem eigenen Seitenverhaeltnis
   * in die Flaeche und verschiebt sie beim Zoomen. Darum wird die Ebene mit den
   * Flaechen genau auf das Rechteck der Seite gelegt und bei jeder Bewegung
   * nachgefuehrt — sonst sitzen die Flaechen waagerecht daneben.
   */
  const syncLayer = useCallback(() => {
    const viewer = viewerRef.current;
    const layer = layerRef.current;
    if (!viewer || !layer) return;
    if (!viewer.world || viewer.world.getItemCount() === 0) {
      layer.style.visibility = "hidden";
      return;
    }
    const bounds = viewer.world.getItemAt(0).getBounds();
    const rect = viewer.viewport.viewportToViewerElementRectangle(bounds);
    layer.style.left = `${rect.x}px`;
    layer.style.top = `${rect.y}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    layer.style.visibility = "visible";
  }, []);

  // Der Betrachter wird einmal je Lesesitzung gebaut, nicht bei jedem Blaettern.
  // Das spart das Abreissen und Neuanlegen der Leinwand und haelt die Ansicht
  // beim schnellen Blaettern ruhig.
  useEffect(() => {
    if (!hostRef.current) return;
    const viewer = OpenSeadragon({
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
    });
    viewerRef.current = viewer;
    setOverlayHost(viewer.canvas as HTMLElement);
    viewer.addHandler("open", () => {
      readyRef.current = true;
      setReady(true);
      setError(null);
      syncLayer();
    });
    viewer.addHandler("update-viewport", syncLayer);
    viewer.addHandler("resize", syncLayer);
    // Der Klick wird hier ausgewertet und nicht am Knopf selbst: OpenSeadragon
    // unterdrueckt auf seiner Leinwand die Folgeereignisse des Zeigers, ein
    // `click` kommt am Knopf also gar nicht mehr an. `quick` trennt dabei den
    // Klick vom Ziehen, damit Verschieben keinen Artikel oeffnet.
    viewer.addHandler("canvas-click", (event: any) => {
      if (!event.quick) return;
      const item = viewer.world.getItemCount() ? viewer.world.getItemAt(0) : null;
      if (!item) return;
      const point = item.viewportToImageCoordinates(
        viewer.viewport.pointFromPixel(event.position),
      );
      const size = item.getContentSize();
      const nx = point.x / size.x;
      const ny = point.y / size.y;
      // Bei Ueberdeckung gewinnt die kleinere Flaeche; sonst verdeckt ein
      // grosser Textblock die Ueberschrift, die darin liegt.
      let best: Region | null = null;
      let bestArea = Infinity;
      for (const r of regionsRef.current) {
        if (nx < r.x0 || nx > r.x1 || ny < r.y0 || ny > r.y1) continue;
        const area = (r.x1 - r.x0) * (r.y1 - r.y0);
        if (area < bestArea) {
          best = r;
          bestArea = area;
        }
      }
      if (best) openArticleRef.current(best.articleId);
    });
    viewer.addHandler("tile-load-failed", () => {
      // Eine einzelne Kachel darf die Seite nicht als kaputt melden;
      // OpenSeadragon holt sie von selbst noch einmal. Nur wenn ueberhaupt
      // nichts steht, bekommt der Leser einen Hinweis.
      if (!readyRef.current) setError("Kacheln konnten nicht geladen werden.");
    });
    return () => {
      setOverlayHost(null);
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [sessionToken, syncLayer]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    readyRef.current = false;
    setReady(false);
    setError(null);
    if (layerRef.current) layerRef.current.style.visibility = "hidden";

    const base = `${TILE_SERVICE_URL}/api/issue/${issueId}/page/${pageIndex}`;

    async function load() {
      let res: Response;
      try {
        res = await fetch(`${base}/info`, {
          headers: { "X-Tile-Session": sessionToken },
        });
      } catch {
        if (!cancelled) setError("Seite konnte nicht geladen werden.");
        return;
      }
      // Ohne diese Pruefung meldet eine laengst ueberholte Anfrage einen Fehler
      // auf einer Seite, die laengst sauber offen ist.
      if (cancelled) return;

      if (res.status === 429 && attempt < MAX_RETRIES) {
        attempt += 1;
        setError("Viele Seiten in kurzer Zeit — wird gleich erneut versucht.");
        timer = window.setTimeout(() => void load(), RETRY_MS);
        return;
      }
      if (!res.ok) {
        setError(
          res.status === 409
            ? "Diese Seite ist noch nicht aufbereitet."
            : res.status === 429
              ? "Zu viele Seiten in kurzer Zeit. Bitte kurz warten."
              : "Seite konnte nicht geladen werden.",
        );
        return;
      }

      const info = await res.json();
      if (cancelled || !viewerRef.current) return;
      setError(null);
      viewerRef.current.open({
        width: info.width,
        height: info.height,
        tileSize: info.tileSize,
        minLevel: 0,
        maxLevel: info.maxLevel,
        getTileUrl: (level: number, x: number, y: number) =>
          // Level zaehlt bei OpenSeadragon von grob nach fein; das Gateway
          // erwartet den Verkleinerungsfaktor, also andersherum.
          `${base}/tile/${info.maxLevel - level}/${x}/${y}.jpg`,
      });
    }

    timer = window.setTimeout(() => void load(), SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [issueId, pageIndex, sessionToken]);

  const pageRegions = regions.filter((r) => r.pageIndex === pageIndex);
  regionsRef.current = pageRegions;

  return (
    <div className="page-mode">
      <div className="page-viewer" ref={hostRef} />
      {!ready && !error && <div className="page-hint">Seite wird geladen...</div>}
      {error && <div className="page-hint err">{error}</div>}

      {/* Blaetterzonen am Rand: Tippen wechselt die Seite, Ziehen zoomt. */}
      <button className="page-edge left" onClick={onPrev} aria-label="Vorherige Seite" />
      <button className="page-edge right" onClick={onNext} aria-label="Nächste Seite" />

      {overlayHost &&
        createPortal(
          <div className="hotspots" ref={layerRef}>
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
          </div>,
          overlayHost,
        )}

      {watermark && <div className="watermark">{watermark}</div>}
    </div>
  );
}
