import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OpenSeadragon from "openseadragon";
import { TILE_SERVICE_URL, type Id } from "../lib/api";
import ReaderTurnButton from "./ReaderTurnButton";
import { kachelSeed, mitTicket, OHNE_NETZ, zusammensetzen } from "./schutz";
import { mitWiederholung } from "./nachladen";
import { kachelLader } from "./kachelLaden";
import { tippZiel, type TippAnzeige } from "./tippZiel";
import type { SeitenInfo, SeitenPuffer } from "./puffer";
import { FEINSTE_STUFE } from "./pufferFuellen";
import { liveAnfrage } from "./vorrang";
import { useVerbunden } from "./offline";

/** Wo auf der Seite getippt wurde, normiert auf 0..1. */
export type Klickpunkt = { pageIndex: number; x: number; y: number };

type Region = {
  articleId: Id<"articles">;
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** "image": Bild des Artikels, nur fuer den Treffertest (Umschlag oder Text). */
  kind?: string;
  targetPageIndex: number | null;
};

/** Eine Flaeche, die nach draussen fuehrt: der Abo-Aufruf zum Laden. */
type PageLink = {
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  url: string;
  label: string | null;
};

type Props = {
  issueId: Id<"issues">;
  pageIndexes: number[];
  spread: boolean;
  /** Lesesitzung; ohne Verbindung (Start aus dem Puffer) noch leer. */
  sessionToken: string | null;
  /** Schluessel zum Zusammensetzen der verwuerfelten Kacheln. */
  schutzKey: number | null;
  /**
   * Offline-Puffer der Ausgabe (`puffer.ts`). Seitenmasse und Kacheln kommen
   * zuerst von dort, mit dem Schluessel ihrer eigenen Sitzung; was vom
   * Gateway kommt, wandert hinein.
   */
  puffer?: SeitenPuffer | null;
  regions: Region[];
  links: PageLink[];
  /** Buchanzeigen mit Produkten im Laden (articleProducts.forReader), je Artikel. */
  anzeigen?: ReadonlyMap<Id<"articles">, TippAnzeige>;
  /** Umschlag einer Anzeige mit mehreren Buechern: welches Buch? */
  onChooseProduct?: (
    articleId: Id<"articles">,
    fromPageIndex?: number,
    punkt?: Klickpunkt,
  ) => void;
  watermark: string;
  onOpenArticle: (
    articleId: Id<"articles">,
    fromPageIndex?: number,
    punkt?: Klickpunkt,
  ) => void;
  onNavigatePage: (pageIndex: number) => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
};

/** `nochmal`: der Hinweis traegt den Knopf "Erneut versuchen". */
type PageNotice = { text: string; tone: "retry" | "error"; nochmal?: boolean };
type PageInfo = SeitenInfo;

/** Antwort des Gateways auf die Seitenmasse, die kein Erfolg war. */
class SeitenStatus extends Error {
  constructor(public status: number) {
    super(`Seite ${status}`);
  }
}

/** Schnell ueberblaetterte Seiten sollen keine unnoetigen Anfragen ausloesen. */
const SETTLE_MS = 180;
/**
 * So lange darf eine Kachel samt Neuversuchen nach 429 dauern. Danach gibt
 * OpenSeadragon den Auftrag ohnehin auf (Zeitlimit 30 s) und versucht es
 * selbst noch einmal.
 */
const KACHEL_FRIST_MS = 20_000;
const NICHT_GELADEN: PageNotice = {
  text: "Seite konnte nicht geladen werden.",
  tone: "error",
  nochmal: true,
};
/** Ohne Verbindung, und die Seite liegt (noch) nicht im Puffer. */
const NICHT_GESPEICHERT: PageNotice = {
  text: "Ohne Verbindung ist diese Seite nicht verfügbar.",
  tone: "error",
  nochmal: true,
};

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
  schutzKey,
  puffer,
  regions,
  links,
  anzeigen,
  onChooseProduct,
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
  // Zaehlt "Erneut versuchen": jeder Druck laedt die Seite neu.
  const [nochmal, setNochmal] = useState(0);
  const readyRef = useRef(false);
  const openedPagesRef = useRef<number[]>([]);
  const regionsRef = useRef(regions);
  const linksRef = useRef(links);
  const openArticleRef = useRef(onOpenArticle);
  const anzeigenRef = useRef(anzeigen);
  const chooseProductRef = useRef(onChooseProduct);
  anzeigenRef.current = anzeigen;
  chooseProductRef.current = onChooseProduct;
  const navigatePageRef = useRef(onNavigatePage);
  regionsRef.current = regions;
  linksRef.current = links;
  // Ein Tipp kann die Seite auf zwei Wegen erreichen (Knopf und
  // Zeichenflaeche); nach draussen darf er nur einmal fuehren.
  const zuletztGeoeffnet = useRef<{ url: string; at: number } | null>(null);
  const nachDraussen = useCallback((url: string) => {
    const now = Date.now();
    const vorher = zuletztGeoeffnet.current;
    if (vorher && vorher.url === url && now - vorher.at < 800) return;
    zuletztGeoeffnet.current = { url, at: now };
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);
  openArticleRef.current = onOpenArticle;
  navigatePageRef.current = onNavigatePage;
  // Sitzung und Puffer lesen die Ladeketten zur Laufzeit: kommt die Sitzung
  // erst nach dem Start aus dem Puffer, bleibt die aufgeschlagene Seite stehen.
  const sitzungRef = useRef(sessionToken);
  sitzungRef.current = sessionToken;
  const pufferRef = useRef(puffer);
  pufferRef.current = puffer;
  const verbunden = useVerbunden();
  const verbundenRef = useRef(verbunden);
  verbundenRef.current = verbunden;
  // Eine Seite fehlte, weil noch keine Sitzung da war: mit ihr neu laden.
  const fehlteSitzung = useRef(false);

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
      tileRetryMax: 3,
      tileRetryDelay: 1000,
      // Groessenaenderungen behandelt der Beobachter unten. OpenSeadragon
      // selbst rechnete den Zoom nach dem Seitenverhaeltnis um: nach dem
      // Ausblenden des Inhaltsverzeichnisses stand die Doppelseite
      // vergroessert da, Kopf, Fuss und rechte Seite abgeschnitten.
      autoResize: false,
    });
    viewerRef.current = viewer;
    setOverlayHost(viewer.canvas as HTMLElement);
    // Steht die ganze Seite im Bild (wie nach dem Oeffnen), wird sie nach
    // jeder Groessenaenderung der Leseflaeche neu eingepasst. Hat der Leser
    // hineingezoomt, bleibt sein Ausschnitt.
    let eingepasst = true;
    viewer.addHandler("open", () => {
      readyRef.current = true;
      setReady(true);
      setNotice(null);
      viewer.viewport.goHome(true);
      eingepasst = true;
      syncLayers();
    });
    viewer.addHandler("animation-finish", () => {
      const vp = viewer.viewport;
      eingepasst = Math.abs(vp.getZoom(true) / vp.getHomeZoom() - 1) < 0.01;
    });
    const beobachter = new ResizeObserver(() => {
      const flaeche = viewer.container as HTMLElement;
      if (!flaeche.clientWidth || !flaeche.clientHeight) return;
      viewer.viewport.resize(
        new OpenSeadragon.Point(flaeche.clientWidth, flaeche.clientHeight),
        true,
      );
      if (eingepasst) viewer.viewport.goHome(true);
      viewer.forceRedraw();
      syncLayers();
    });
    beobachter.observe(hostRef.current);
    viewer.addHandler("open-failed", () => {
      readyRef.current = false;
      setReady(false);
      setNotice(NICHT_GELADEN);
    });
    viewer.addHandler("update-viewport", syncLayers);
    viewer.addHandler("resize", syncLayers);

    viewer.addHandler("canvas-click", (event: any) => {
      if (!event.quick || !readyRef.current) return;
      const viewportPoint = viewer.viewport.pointFromPixel(event.position, true);

      for (let slot = 0; slot < viewer.world.getItemCount(); slot += 1) {
        const item = viewer.world.getItemAt(slot);
        const point = item.viewportToImageCoordinates(viewportPoint);
        const size = item.getContentSize();
        const nx = point.x / size.x;
        const ny = point.y / size.y;
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
        const pageIndex = openedPagesRef.current[slot];
        const punkt: Klickpunkt = { pageIndex, x: nx, y: ny };
        // Der Knopf darunter bekommt den Klick nie: OpenSeadragon bricht ihn
        // an der Zeichenflaeche ab, bevor er bei React ankommt. Was der Tipp
        // oeffnet (Laden, Text, Auswahl), entscheidet `tippZiel`.
        const ziel = tippZiel(
          punkt,
          linksRef.current,
          regionsRef.current,
          anzeigenRef.current ?? new Map(),
        );
        if (!ziel) return;
        if (ziel.art === "laden") nachDraussen(ziel.url);
        else if (ziel.art === "seite") navigatePageRef.current(ziel.pageIndex);
        else if (ziel.art === "auswahl" && chooseProductRef.current) {
          chooseProductRef.current(ziel.articleId, pageIndex, punkt);
        } else {
          // Mit Seite und Punkt: der Artikel oeffnet beim angetippten Absatz.
          openArticleRef.current(ziel.articleId, pageIndex, punkt);
        }
        return;
      }
    });
    viewer.addHandler("tile-load-failed", (event: any) => {
      // `open` bedeutet bei OpenSeadragon nur, dass die TileSource bekannt ist;
      // die eigentlichen Kacheln kommen danach. Erst wenn alle eingebauten
      // Wiederholungen verbraucht sind, zeigen wir den ruhigen Fehlerhinweis.
      if (
        !event.maxReached ||
        !event.tiledImage ||
        viewer.world.getIndexOfItem(event.tiledImage) === -1
      ) {
        return;
      }
      const ohneNetz =
        !verbundenRef.current || String(event.message ?? "").includes(OHNE_NETZ);
      if (!ohneNetz) {
        setNotice(NICHT_GELADEN);
        return;
      }
      // Ohne Verbindung fehlt im Puffer nur die volle Aufloesung (Stufe 0):
      // die Seite steht dann in der naechstgroeberen da, ohne Hinweis. Fehlt
      // eine groebere Stufe, ist die Seite nicht gespeichert. Mit Verbindung
      // fehlte nur die Sitzung; mit ihr laedt die Seite neu.
      const stufe = (event.tiledImage.source?.maxLevel ?? 0) - (event.tile?.level ?? 0);
      if (!verbundenRef.current && stufe >= FEINSTE_STUFE) setNotice(NICHT_GESPEICHERT);
    });

    return () => {
      beobachter.disconnect();
      setOverlayHost(null);
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [syncLayers, nachDraussen]);

  const schutzKeyRef = useRef(schutzKey);
  schutzKeyRef.current = schutzKey;

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const abortController = new AbortController();
    // Alle Ladeketten dieser Seiten; beim Blaettern bricht der Aufraeumer sie
    // ab (kachelLaden.ts).
    const kacheln = kachelLader(async (src, signal, aktuell) => {
      const teile = /\/page\/(\d+)\/tile\/(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(src)!;
      const [seite, stufe, spalte, zeile] = teile.slice(1).map(Number);
      const seed = (k: number) =>
        kachelSeed(k, issueId, teile[1], teile[2], teile[3], teile[4]);
      // Zuerst der Offline-Puffer: die Kachel liegt dort verwuerfelt, mit dem
      // Schluessel der Sitzung, mit der sie geholt wurde.
      const gepuffert = await pufferRef.current?.kachel(seite, stufe, spalte, zeile);
      if (gepuffert) {
        const bild = await createImageBitmap(new Blob([gepuffert.daten]));
        return zusammensetzen(bild, seed(gepuffert.k)).getContext("2d");
      }
      const token = sitzungRef.current;
      const key = schutzKeyRef.current;
      if (!token || key === null) {
        fehlteSitzung.current = true;
        throw new Error(OHNE_NETZ);
      }
      // Je Versuch ein frisches Ticket; gebremste Kacheln kommen nach einer
      // kurzen Pause von selbst, solange die Kachel noch gefragt ist.
      const res = await liveAnfrage(
        mitWiederholung(
          () => {
            if (!aktuell()) throw new DOMException("Kachel nicht mehr gefragt", "AbortError");
            return mitTicket(src, token, issueId, signal);
          },
          signal,
          undefined,
          { bisMs: KACHEL_FRIST_MS },
        ),
      );
      if (!res.ok) throw new Error(`Kachel ${res.status}`);
      const daten = await res.arrayBuffer();
      pufferRef.current?.kachelAblegen(seite, stufe, spalte, zeile, key, daten);
      const bild = await createImageBitmap(new Blob([daten]));
      return zusammensetzen(bild, seed(key)).getContext("2d");
    });
    readyRef.current = false;
    openedPagesRef.current = [];
    setReady(false);
    setNotice(null);
    viewerRef.current?.close();
    for (const layer of layerRefs.current) {
      if (layer) layer.style.visibility = "hidden";
    }

    /** Seitenmasse: aus dem Puffer, sonst vom Gateway; null ohne Sitzung. */
    async function seitenInfo(pageIndex: number): Promise<PageInfo | null> {
      const gepuffert = await pufferRef.current?.info(pageIndex);
      if (gepuffert) return gepuffert;
      const token = sitzungRef.current;
      if (!token) return null;
      // Gebremst (429) wartet der Leser und fragt selbst nach; bei einem
      // Netz- oder Serverfehler einmal (nachladen.ts).
      const response = await mitWiederholung(
        () =>
          fetch(`${TILE_SERVICE_URL}/api/issue/${issueId}/page/${pageIndex}/info`, {
            headers: { "X-Tile-Session": token },
            signal: abortController.signal,
          }),
        abortController.signal,
        () => {
          if (!cancelled) setNotice({ text: "Seite wird gleich geladen …", tone: "retry" });
        },
      );
      if (!response.ok) throw new SeitenStatus(response.status);
      const info = (await response.json()) as PageInfo;
      pufferRef.current?.infoAblegen(pageIndex, info);
      return info;
    }

    async function load() {
      try {
        const geladen = await Promise.all(shown.map(seitenInfo));
        if (cancelled) return;

        if (geladen.some((info) => info === null)) {
          // Noch keine Sitzung (Start aus dem Puffer) und die Seite nicht im
          // Puffer: mit Verbindung kommt sie gleich, ohne nicht.
          fehlteSitzung.current = true;
          if (!verbundenRef.current) setNotice(NICHT_GESPEICHERT);
          return;
        }
        const infos = geladen as PageInfo[];
        if (cancelled || !viewerRef.current) return;

        let worldX = 0;
        const tileSources = infos.map((info, slot) => {
          const pageIndex = shown[slot];
          const base = `${TILE_SERVICE_URL}/api/issue/${issueId}/page/${pageIndex}`;
          // Gleiche Welthoehe, reale Seitenbreite: dadurch beruehren sich die
          // Seiten exakt bei worldX, ohne kuenstlichen Zwischenraum.
          const worldWidth = info.width / info.height;
          const tileSource: any = new (OpenSeadragon as any).TileSource({
            width: info.width,
            height: info.height,
            tileSize: info.tileSize,
            tileOverlap: 0,
            minLevel: 0,
            maxLevel: info.maxLevel,
          });
          tileSource.getTileUrl = (level: number, x: number, y: number) =>
            `${base}/tile/${info.maxLevel - level}/${x}/${y}.jpg`;
          // Kacheln kommen verwuerfelt (`tile-service/schutz.py`) und werden
          // erst hier auf einer Zeichenflaeche zusammengesetzt.
          tileSource.downloadTileStart = (job: any) => kacheln.start(job);
          tileSource.downloadTileAbort = (job: any) => kacheln.abbrechen(job);
          const spec = { x: worldX, y: 0, width: worldWidth, tileSource };
          worldX += worldWidth;
          return spec;
        });

        setNotice(null);
        openedPagesRef.current = [...shown];
        viewerRef.current.open(tileSources);
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return;
        if (error instanceof SeitenStatus && error.status === 409) {
          setNotice({ text: "Diese Seite ist noch nicht aufbereitet.", tone: "error" });
        } else {
          setNotice(verbundenRef.current ? NICHT_GELADEN : NICHT_GESPEICHERT);
        }
      }
    }

    timer = window.setTimeout(() => void load(), SETTLE_MS);
    return () => {
      cancelled = true;
      abortController.abort();
      kacheln.alleAbbrechen();
      window.clearTimeout(timer);
    };
    // Die konkrete Folge ist absichtlich Teil der Abhaengigkeit. Die Sitzung
    // nicht: die Ladeketten lesen sie zur Laufzeit (sitzungRef).
  }, [issueId, pageIndexes.join(","), nochmal]);

  // Kommt die Sitzung oder die Verbindung zurueck, laedt eine Seite neu, die
  // ohne sie nicht zu haben war.
  useEffect(() => {
    if (!sessionToken || !fehlteSitzung.current) return;
    fehlteSitzung.current = false;
    setNochmal((n) => n + 1);
  }, [sessionToken]);
  useEffect(() => {
    if (verbunden && notice === NICHT_GESPEICHERT) setNochmal((n) => n + 1);
  }, [verbunden, notice]);

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
            {notice.nochmal && (
              <>
                {" "}
                <button
                  type="button"
                  className="btn quiet small"
                  onClick={() => setNochmal((n) => n + 1)}
                >
                  Erneut versuchen
                </button>
              </>
            )}
          </div>
        )}

        {overlayHost &&
          createPortal(
            <>
              {shown.map((pageIndex, slot) => {
                const pageRegions = regions.filter(
                  (region) => region.pageIndex === pageIndex && region.kind !== "image",
                );
                const pageLinks = links.filter((link) => link.pageIndex === pageIndex);
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
                            : onOpenArticle(region.articleId, region.pageIndex)
                        }
                        aria-label={
                          region.targetPageIndex !== null
                            ? "Zur Seite springen"
                            : "Artikel öffnen"
                        }
                      />
                    ))}
                    {/* Nach draussen geht es ohne Zwischenfrage, im neuen Tab.
                        Den Klick verarbeitet der Treffertest der Zeichenflaeche
                        oben; der Knopf hier zeigt die Flaeche beim Zeigen und
                        traegt sie fuer Tastatur und Vorleser. */}
                    {pageLinks.map((link, index) => (
                      <button
                        key={`link-${index}`}
                        className="hotspot hotspot-link"
                        style={{
                          left: `${link.x0 * 100}%`,
                          top: `${link.y0 * 100}%`,
                          width: `${(link.x1 - link.x0) * 100}%`,
                          height: `${(link.y1 - link.y0) * 100}%`,
                        }}
                        onClick={() => nachDraussen(link.url)}
                        aria-label={
                          link.label ? `${link.label} – im Laden öffnen` : "Im Laden öffnen"
                        }
                        title="Öffnet den Laden in einem neuen Tab"
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
