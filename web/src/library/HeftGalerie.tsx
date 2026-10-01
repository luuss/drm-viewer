import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OpenSeadragon from "openseadragon";
import Icon from "../components/Icon";

/** `titel`: das Titelbild fuellt den Rahmen, eine Heftseite steht ganz darin. */
export type GalerieBild = { url: string; alt: string; titel?: boolean };

/**
 * Bilder eines Hefts in der Vorschau: Titelbild und dahinter die Seiten des
 * gedruckten Inhaltsverzeichnisses, wie in einem Laden. Die Miniaturen unter
 * dem grossen Bild zeigen, dass es mehr als eines gibt; ein Klick auf das
 * grosse Bild oeffnet die Lupe.
 */
export default function HeftGalerie({
  bilder,
  start = 0,
}: {
  bilder: GalerieBild[];
  start?: number;
}) {
  const [aktiv, setAktiv] = useState(Math.min(start, bilder.length - 1));
  const [lupe, setLupe] = useState(false);
  const bild = bilder[aktiv] ?? bilder[0];

  // Kommt ein Verzeichnis erst nach dem ersten Zeichnen an, bleibt die Wahl gueltig.
  useEffect(() => {
    if (aktiv >= bilder.length) setAktiv(0);
  }, [aktiv, bilder.length]);

  return (
    <div className="heft-galerie">
      <button
        type="button"
        className={`galerie-haupt${bild.titel ? " titel" : ""}`}
        onClick={() => setLupe(true)}
        aria-label={`${bild.alt} vergrößern`}
      >
        <img src={bild.url} alt={bild.alt} />
        <span className="galerie-lupe" aria-hidden="true">
          <Icon name="zoom-in" size={20} />
        </span>
      </button>
      {bilder.length > 1 && (
        <div className="galerie-daumen">
          {bilder.map((b, i) => (
            <button
              key={b.url}
              type="button"
              className={i === aktiv ? "on" : undefined}
              aria-pressed={i === aktiv}
              aria-label={b.alt}
              onClick={() => setAktiv(i)}
            >
              <img src={b.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {lupe && (
        <BildLupe
          bilder={bilder}
          index={aktiv}
          onIndex={setAktiv}
          onClose={() => setLupe(false)}
        />
      )}
    </div>
  );
}

/**
 * Vollbild mit stufenlosem Zoom. OpenSeadragon bringt Mausrad, Ziehen und
 * Zwei-Finger-Zoom mit; die Seitenbilder haben 2400 Pixel Breite, das reicht,
 * um auch die kleine Schrift im Verzeichnis zu lesen.
 */
function BildLupe({
  bilder,
  index,
  onIndex,
  onClose,
}: {
  bilder: GalerieBild[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const offenRef = useRef(index);

  // Ein einfaches Bild ohne Kacheln; OpenSeadragon baut die Stufen selbst.
  const quelle = (i: number) => ({ type: "image", url: bilder[i].url });

  useEffect(() => {
    if (!hostRef.current) return;
    const viewer = OpenSeadragon({
      element: hostRef.current,
      showNavigationControl: false,
      keyboardNavEnabled: false,
      gestureSettingsMouse: { clickToZoom: true, dblClickToZoom: false, scrollToZoom: true },
      gestureSettingsTouch: { pinchToZoom: true, flickEnabled: true, dblClickToZoom: true },
      visibilityRatio: 0.5,
      minZoomImageRatio: 0.8,
      maxZoomPixelRatio: 3,
      animationTime: 0.35,
      tileSources: quelle(indexRef.current),
    });
    viewerRef.current = viewer;
    offenRef.current = indexRef.current;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
    // Der Betrachter bleibt; beim Wechsel tauscht nur das Bild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!viewerRef.current || offenRef.current === index) return;
    offenRef.current = index;
    viewerRef.current.open({ tileSource: quelle(index) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const zoom = useCallback((faktor: number) => {
    const vp = viewerRef.current?.viewport;
    if (!vp) return;
    vp.zoomBy(faktor);
    vp.applyConstraints();
  }, []);

  const blaettern = useCallback(
    (schritt: number) => {
      const n = bilder.length;
      onIndex((indexRef.current + schritt + n) % n);
    },
    [bilder.length, onIndex],
  );

  // Tastatur, Seitenhintergrund festhalten, Fokus hinein und zurueck. Einmal
  // fuer die ganze Lupe; die Handlungen kommen frisch aus der Referenz.
  const tastenRef = useRef<(e: KeyboardEvent) => void>(() => {});
  tastenRef.current = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowLeft" && bilder.length > 1) blaettern(-1);
    else if (e.key === "ArrowRight" && bilder.length > 1) blaettern(1);
    else if (e.key === "+" || e.key === "=") zoom(1.5);
    else if (e.key === "-") zoom(1 / 1.5);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const vorher = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const taste = (e: KeyboardEvent) => tastenRef.current(e);
    window.addEventListener("keydown", taste);
    return () => {
      window.removeEventListener("keydown", taste);
      document.body.style.overflow = overflow;
      vorher?.focus();
    };
  }, []);

  return createPortal(
    <div className="bild-lupe" role="dialog" aria-modal="true" aria-label={bilder[index].alt}>
      <div className="lupe-bild" ref={hostRef} />
      <button
        ref={closeRef}
        type="button"
        className="lupe-knopf lupe-zu"
        onClick={onClose}
        aria-label="Schließen"
      >
        <Icon name="close" size={22} />
      </button>
      {bilder.length > 1 && (
        <>
          <button
            type="button"
            className="lupe-knopf lupe-zurueck"
            onClick={() => blaettern(-1)}
            aria-label="Vorheriges Bild"
          >
            <Icon name="arrow-left" size={22} />
          </button>
          <button
            type="button"
            className="lupe-knopf lupe-weiter"
            onClick={() => blaettern(1)}
            aria-label="Nächstes Bild"
          >
            <Icon name="arrow-right" size={22} />
          </button>
        </>
      )}
      <div className="lupe-leiste">
        {bilder.length > 1 &&
          bilder.map((b, i) => (
            <button
              key={b.url}
              type="button"
              className={`lupe-daumen${i === index ? " on" : ""}`}
              aria-pressed={i === index}
              aria-label={b.alt}
              onClick={() => onIndex(i)}
            >
              <img src={b.url} alt="" />
            </button>
          ))}
        <button
          type="button"
          className="lupe-knopf"
          onClick={() => zoom(1 / 1.5)}
          aria-label="Verkleinern"
        >
          <Icon name="zoom-out" size={22} />
        </button>
        <button
          type="button"
          className="lupe-knopf"
          onClick={() => zoom(1.5)}
          aria-label="Vergrößern"
        >
          <Icon name="zoom-in" size={22} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
