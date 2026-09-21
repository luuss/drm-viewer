import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OpenSeadragon from "openseadragon";
import { TILE_SERVICE_URL, type Id } from "../lib/api";
import ReaderTurnButton from "./ReaderTurnButton";

type Region = {
  articleId: Id<"articles">;
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  targetPageIndex: number | null;
};

type Props = {
  issueId: Id<"issues">;
  pageIndexes: number[];
  spread: boolean;
  sessionToken: string;
  regions: Region[];
  watermark: string;
  onOpenArticle: (articleId: Id<"articles">) => void;
  onNavigatePage: (pageIndex: number) => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
};

type PageNotice = { text: string; tone: "retry" | "error" };
type PageInfo = {
  width: number;
  height: number;
  tileSize: number;
  maxLevel: number;
};

/** Schnell ueberblaetterte Seiten sollen keine unnoetigen Anfragen ausloesen. */
const SETTLE_MS = 180;
const RETRY_MS = 2500;
const MAX_RETRIES = 4;

/**
 * Originalgetreue Einzel- oder Doppelseite. Eine Doppelseite lebt in genau
 * einer OpenSeadragon-Welt: beide Seiten beruehren sich am Bund und teilen
 * Zoom sowie Verschiebung wie eine einzige grosse Heftflaeche.
 */
export default function PageMode({
  issueId,
  pageIndexes,
  spread,
  sessionToken,
  regions,
  watermark,
  onOpenArticle,
  onNavigatePage,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: Props) {
  const shown = pageIndexes.slice(0, 2);
  const hasTwoPages = shown.length > 1;
  const hostRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const viewerRef = useRef<any>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState<PageNotice | null>(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const openedPagesRef = useRef<number[]>([]);
  const regionsRef = useRef(regions);
  const openArticleRef = useRef(onOpenArticle);
  const navigatePageRef = useRef(onNavigatePage);
  regionsRef.current = regions;
  openArticleRef.current = onOpenArticle;
  navigatePageRef.current = onNavigatePage;

  /** Jede Hotspot-Ebene folgt ihrem Seitenbild in der gemeinsamen Welt. */
  const syncLayers = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const layer of layerRefs.current) {
      if (layer) layer.style.visibility = "hidden";
    }
    if (!viewer.world) return;
    const count = Math.min(viewer.world.getItemCount(), openedPagesRef.current.length);
    for (let slot = 0; slot < count; slot += 1) {
      const layer = layerRefs.current[slot];
      if (!layer) continue;
      const bounds = viewer.world.getItemAt(slot).getBounds();
      const rect = viewer.viewport.viewportToViewerElementRectangle(bounds);
      layer.style.left = `${rect.x}px`;
      layer.style.top = `${rect.y}px`;
      layer.style.width = `${rect.width}px`;
      layer.style.height = `${rect.height}px`;
      layer.style.visibility = "visible";
    }
  }, []);

  // Der gemeinsame Betrachter bleibt beim Blaettern bestehen; nur seine ein
  // oder zwei TileSources wechseln.
  useEffect(() => {
    if (!hostRef.current) return;
    const viewer = OpenSeadragon({
      element: hostRef.current,
      showNavigationControl: false,
      keyboardNavEnabled: false,
      gestureSettingsMouse: { clickToZoom: false, scrollToZoom: true },
      gestureSettingsTouch: { pinchToZoom: true, flickEnabled: true },
      visibilityRatio: 1,
      minZoomImageRatio: 0.9,
      maxZoomPixelRatio: 2.5,
      animationTime: 0.4,
      springStiffness: 8,
      loadTilesWithAjax: true,
      tileRetryMax: 3,
      tileRetryDelay: 1000,
      ajaxHeaders: { "X-Tile-Session": sessionToken },
    });
    viewerRef.current = viewer;
    setOverlayHost(viewer.canvas as HTMLElement);
    viewer.addHandler("open", () => {
      readyRef.current = true;
      setReady(true);
      setNotice(null);
      viewer.viewport.goHome(true);
      syncLayers();
    });
    viewer.addHandler("open-failed", () => {
      readyRef.current = false;
      setReady(false);
      setNotice({ text: "Seite konnte nicht geladen werden.", tone: "error" });
    });
    viewer.addHandler("update-viewport", syncLayers);
    viewer.addHandler("resize", syncLayers);

    viewer.addHandler("canvas-click", (event: any) => {
      if (!event.quick || !readyRef.current) return;
      const viewportPoint = viewer.viewport.pointFromPixel(event.position, true);
      let best: Region | null = null;
      let bestArea = Infinity;

      for (let slot = 0; slot < viewer.world.getItemCount(); slot += 1) {
        const item = viewer.world.getItemAt(slot);
        const point = item.viewportToImageCoordinates(viewportPoint);
        const size = item.getContentSize();
        const nx = point.x / size.x;
        const ny = point.y / size.y;
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
        const pageIndex = openedPagesRef.current[slot];
        for (const region of regionsRef.current) {
          if (region.pageIndex !== pageIndex) continue;
          if (nx < region.x0 || nx > region.x1 || ny < region.y0 || ny > region.y1) {
            continue;
          }
          const area = (region.x1 - region.x0) * (region.y1 - region.y0);
          if (area < bestArea) {
            best = region;
            bestArea = area;
          }
        }
      }

      if (best) {
        if (best.targetPageIndex !== null) navigatePageRef.current(best.targetPageIndex);
        else openArticleRef.current(best.articleId);
      }
    });
    viewer.addHandler("tile-load-failed", (event: any) => {
      // `open` bedeutet bei OpenSeadragon nur, dass die TileSource bekannt ist;
      // die eigentlichen Kacheln kommen danach. Erst wenn alle eingebauten
      // Wiederholungen verbraucht sind, zeigen wir den ruhigen Fehlerhinweis.
      if (
        event.maxReached &&
        event.tiledImage &&
        viewer.world.getIndexOfItem(event.tiledImage) !== -1
      ) {
        setNotice({ text: "Seite konnte nicht geladen werden.", tone: "error" });
      }
    });

    return () => {
      setOverlayHost(null);
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [sessionToken, syncLayers]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    const abortController = new AbortController();
    readyRef.current = false;
    openedPagesRef.current = [];
    setReady(false);
    setNotice(null);
    viewerRef.current?.close();
    for (const layer of layerRefs.current) {
      if (layer) layer.style.visibility = "hidden";
    }

    async function load() {
      try {
        const responses = await Promise.all(
          shown.map((pageIndex) =>
            fetch(`${TILE_SERVICE_URL}/api/issue/${issueId}/page/${pageIndex}/info`, {
              headers: { "X-Tile-Session": sessionToken },
              signal: abortController.signal,
            }),
          ),
        );
        if (cancelled) return;

        if (responses.some((response) => response.status === 429) && attempt < MAX_RETRIES) {
          attempt += 1;
          setNotice({ text: "Seite wird gleich geladen …", tone: "retry" });
          timer = window.setTimeout(() => void load(), RETRY_MS);
          return;
        }
        const failed = responses.find((response) => !response.ok);
        if (failed) {
          setNotice({
            text:
              failed.status === 409
                ? "Diese Seite ist noch nicht aufbereitet."
                : failed.status === 429
                  ? "Die Seite braucht gerade etwas länger. Bitte kurz warten."
                  : "Seite konnte nicht geladen werden.",
            tone: "error",
          });
          return;
        }

        const infos = (await Promise.all(
          responses.map((response) => response.json()),
        )) as PageInfo[];
        if (cancelled || !viewerRef.current) return;

        let worldX = 0;
        const tileSources = infos.map((info, slot) => {
          const pageIndex = shown[slot];
          const base = `${TILE_SERVICE_URL}/api/issue/${issueId}/page/${pageIndex}`;
          // Gleiche Welthoehe, reale Seitenbreite: dadurch beruehren sich die
          // Seiten exakt bei worldX, ohne kuenstlichen Zwischenraum.
          const worldWidth = info.width / info.height;
          const spec = {
            x: worldX,
            y: 0,
            width: worldWidth,
            tileSource: {
              width: info.width,
              height: info.height,
              tileSize: info.tileSize,
              minLevel: 0,
              maxLevel: info.maxLevel,
              getTileUrl: (level: number, x: number, y: number) =>
                `${base}/tile/${info.maxLevel - level}/${x}/${y}.jpg`,
            },
          };
          worldX += worldWidth;
          return spec;
        });

        setNotice(null);
        openedPagesRef.current = [...shown];
        viewerRef.current.open(tileSources);
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
          setNotice({ text: "Seite konnte nicht geladen werden.", tone: "error" });
        }
      }
    }

    timer = window.setTimeout(() => void load(), SETTLE_MS);
    return () => {
      cancelled = true;
      abortController.abort();
      window.clearTimeout(timer);
    };
    // Die konkrete Folge ist absichtlich Teil der Abhaengigkeit.
  }, [issueId, sessionToken, pageIndexes.join(",")]);

  return (
    <div className={`page-mode ${spread ? "spread" : "single"} ${hasTwoPages ? "two-pages" : "one-page"}`}>
      <div className="page-spread" role="group" aria-label={spread ? "Doppelseite" : "Einzelseite"}>
        <div className="page-viewer" ref={hostRef} />
        {!ready && !notice && <div className="page-hint">Seite wird geladen …</div>}
        {notice && (
          <div
            className={`page-hint ${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {notice.text}
          </div>
        )}

        {overlayHost &&
          createPortal(
            <>
              {shown.map((pageIndex, slot) => {
                const pageRegions = regions.filter((region) => region.pageIndex === pageIndex);
                return (
                  <div
                    key={pageIndex}
                    className="hotspots"
                    ref={(node) => {
                      layerRefs.current[slot] = node;
                    }}
                  >
                    {pageRegions.map((region, index) => (
                      <button
                        key={`${region.articleId}-${index}`}
                        className="hotspot"
                        style={{
                          left: `${region.x0 * 100}%`,
                          top: `${region.y0 * 100}%`,
                          width: `${(region.x1 - region.x0) * 100}%`,
                          height: `${(region.y1 - region.y0) * 100}%`,
                        }}
                        onClick={() =>
                          region.targetPageIndex !== null
                            ? onNavigatePage(region.targetPageIndex)
                            : onOpenArticle(region.articleId)
                        }
                        aria-label={
                          region.targetPageIndex !== null
                            ? "Zur Seite springen"
                            : "Artikel öffnen"
                        }
                      />
                    ))}
                  </div>
                );
              })}
            </>,
            overlayHost,
          )}
      </div>

      <ReaderTurnButton
        direction="previous"
        label={spread ? "Vorherige Doppelseite" : "Vorherige Seite"}
        disabled={!canPrev}
        onClick={onPrev}
      />
      <ReaderTurnButton
        direction="next"
        label={spread ? "Nächste Doppelseite" : "Nächste Seite"}
        disabled={!canNext}
        onClick={onNext}
      />

      {watermark && <div className="watermark">{watermark}</div>}
    </div>
  );
}
