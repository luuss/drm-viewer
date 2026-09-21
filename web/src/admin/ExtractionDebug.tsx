import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import Icon from "../components/Icon";

type RegionKind = "body" | "title" | "image" | "other";

type DebugPage = {
  _id: Id<"issuePages">;
  index: number;
  printedLabel: string | null;
  role: string;
  sourcePageIndex: number;
  width: number;
  height: number;
  previewKey: string | null;
  previewUrl: string | null;
};

type DebugRegion = {
  _id: Id<"articleRegions">;
  pageIndex: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: RegionKind;
};

type DebugArticle = {
  _id: Id<"articles">;
  order: number;
  title: string;
  source: "idml" | "pdf" | "manual" | "hybrid";
  reviewStatus: "pending" | "approved" | "excluded";
  confidence: number | null;
  primaryPageIndex: number;
  pageStart: number;
  pageEnd: number;
  charCount: number;
  blocks: Array<{
    _id: Id<"articleBlocks">;
    order: number;
    type: string;
    text: string;
    sourcePageIndex: number | null;
  }>;
  regions: DebugRegion[];
  images: Array<{
    order: number;
    caption: string | null;
    sourcePageIndex: number | null;
    afterBlockOrder: number | null;
  }>;
};

const KINDS: Array<{ kind: RegionKind; label: string }> = [
  { kind: "title", label: "Titel" },
  { kind: "body", label: "Text" },
  { kind: "image", label: "Bild" },
  { kind: "other", label: "Sonstiges" },
];

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function isSuspicious(region: DebugRegion) {
  return (
    region.x0 < 0 ||
    region.y0 < 0 ||
    region.x1 > 1 ||
    region.y1 > 1 ||
    region.x0 >= region.x1 ||
    region.y0 >= region.y1
  );
}

/**
 * Entwicklungsansicht fuer die Seitenerkennung. Sie zeigt absichtlich die
 * rohen Regionen vor der Reader-Bereinigung, damit verdrehte und ueberstehende
 * Rechtecke nicht unsichtbar werden.
 */
export default function ExtractionDebug({ issueId }: { issueId: Id<"issues"> }) {
  const pageRows = useQuery(api.issuePages.debugForEditors, { issueId });
  const articleRows = useQuery(api.articles.listForEditors, { issueId });
  const pages = (pageRows ?? []) as DebugPage[];
  const articles = (articleRows ?? []) as DebugArticle[];
  const [spreadIndex, setSpreadIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [showLabels, setShowLabels] = useState(true);
  const [visibleKinds, setVisibleKinds] = useState<Record<RegionKind, boolean>>({
    title: true,
    body: true,
    image: true,
    other: true,
  });
  const [selectedArticleId, setSelectedArticleId] = useState<Id<"articles"> | null>(null);

  const spreadStarts = useMemo(() => {
    if (pages.length === 0) return [];
    const starts = [0];
    for (let index = 1; index < pages.length; index += 2) starts.push(index);
    return starts;
  }, [pages.length]);

  useEffect(() => {
    setSpreadIndex((current) => Math.min(current, Math.max(0, spreadStarts.length - 1)));
  }, [spreadStarts.length]);

  const currentStart = spreadStarts[spreadIndex] ?? 0;
  const leftPage = currentStart === 0 ? null : (pages[currentStart] ?? null);
  const rightPage = currentStart === 0 ? (pages[0] ?? null) : (pages[currentStart + 1] ?? null);
  const canPrev = spreadIndex > 0;
  const canNext = spreadIndex < spreadStarts.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target?.tagName ?? "")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      if (event.key === "ArrowLeft" && canPrev) setSpreadIndex((value) => value - 1);
      if (event.key === "ArrowRight" && canNext) setSpreadIndex((value) => value + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canPrev, canNext]);

  const regionsByPage = useMemo(() => {
    const result = new Map<number, Array<{ article: DebugArticle; region: DebugRegion }>>();
    for (const article of articles) {
      for (const region of article.regions) {
        const rows = result.get(region.pageIndex) ?? [];
        rows.push({ article, region });
        result.set(region.pageIndex, rows);
      }
    }
    return result;
  }, [articles]);

  const selectedArticle =
    articles.find((article) => article._id === selectedArticleId) ?? null;
  const visiblePageIndices = [leftPage?.index, rightPage?.index].filter(
    (value): value is number => value !== undefined,
  );
  const visibleRegions = visiblePageIndices.flatMap((index) => regionsByPage.get(index) ?? []);
  const suspiciousCount = visibleRegions.filter(({ region }) => isSuspicious(region)).length;

  const choosePage = (pageIndex: number) => {
    const targetSpread =
      pageIndex === 0 ? 0 : Math.floor((Math.max(1, pageIndex) - 1) / 2) + 1;
    setSpreadIndex(Math.min(targetSpread, Math.max(0, spreadStarts.length - 1)));
  };

  if (pageRows === undefined || articleRows === undefined) {
    return <p className="hint">Debugansicht wird geladen...</p>;
  }

  if (pages.length === 0) {
    return (
      <div className="empty">
        <p>Noch keine gerenderten Seiten. Zuerst den Import ausführen.</p>
      </div>
    );
  }

  const renderPage = (page: DebugPage | null, side: "left" | "right") => {
    if (!page) return <div className={`debug-page-slot empty-slot ${side}`} aria-hidden="true" />;
    const pageRegions = regionsByPage.get(page.index) ?? [];
    return (
      <figure className={`debug-page-slot ${side}`}>
        <figcaption>
          <span>
            <strong>{page.printedLabel ?? page.index + 1}</strong>
            <span className="debug-page-index">Leseseite {page.index + 1}</span>
          </span>
          <span className="debug-page-role">{page.role}</span>
        </figcaption>
        <div
          className="debug-page-sheet"
          style={{ aspectRatio: `${page.width || 3} / ${page.height || 4}` }}
        >
          {page.previewUrl ? (
            <img src={page.previewUrl} alt={`Debugvorschau Seite ${page.printedLabel ?? page.index + 1}`} />
          ) : (
            <div className="debug-page-missing">
              <Icon name="pages" size={28} />
              <span>Vorschau fehlt</span>
            </div>
          )}
          <div className={showLabels ? "debug-regions labels" : "debug-regions"}>
            {pageRegions.map(({ article, region }) => {
              if (!visibleKinds[region.kind]) return null;
              const x0 = clamp(Math.min(region.x0, region.x1));
              const x1 = clamp(Math.max(region.x0, region.x1));
              const y0 = clamp(Math.min(region.y0, region.y1));
              const y1 = clamp(Math.max(region.y0, region.y1));
              const suspicious = isSuspicious(region);
              const selected = selectedArticleId === article._id;
              return (
                <button
                  type="button"
                  key={region._id}
                  className={`debug-region ${region.kind}${suspicious ? " suspicious" : ""}${selected ? " selected" : ""}`}
                  style={{
                    left: `${x0 * 100}%`,
                    top: `${y0 * 100}%`,
                    width: `${Math.max(0.004, x1 - x0) * 100}%`,
                    height: `${Math.max(0.004, y1 - y0) * 100}%`,
                  }}
                  onClick={() => setSelectedArticleId(article._id)}
                  title={`A${article.order}: ${article.title} · ${region.kind}`}
                >
                  <span>A{article.order} · {region.kind}{suspicious ? " !" : ""}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="debug-page-meta">
          <span>{page.width} × {page.height}px</span>
          <span>Quelle S. {page.sourcePageIndex + 1}</span>
          <span>{pageRegions.length} Regionen</span>
          {!page.previewUrl && <span className="debug-warning">nicht gerendert</span>}
        </div>
      </figure>
    );
  };

  return (
    <div className="extraction-debug">
      <header className="debug-head">
        <div>
          <h4>Extraktions-Debug</h4>
          <p className="hint">
            Rohe Erkennungsflächen auf der gedruckten Doppelseite. Klick auf eine Fläche
            zeigt den zugehörigen Artikel.
          </p>
        </div>
        <div className="debug-summary" aria-label="Zusammenfassung">
          <span><strong>{pages.length}</strong> Seiten</span>
          <span><strong>{articles.length}</strong> Artikel</span>
          <span className={suspiciousCount ? "warn" : ""}>
            <strong>{suspiciousCount}</strong> auffällig im Spread
          </span>
        </div>
      </header>

      <div className="debug-toolbar">
        <div className="debug-pagination">
          <button
            type="button"
            className="btn secondary small"
            disabled={!canPrev}
            onClick={() => setSpreadIndex((value) => value - 1)}
            aria-label="Vorherige Doppelseite"
          >
            <Icon name="arrow-left" />
          </button>
          <label>
            Doppelseite
            <select
              value={currentStart}
              onChange={(event) => choosePage(Number(event.target.value))}
            >
              {spreadStarts.map((start, index) => {
                const first = pages[start];
                const second = start === 0 ? null : pages[start + 1];
                return (
                  <option key={start} value={start}>
                    {index + 1}: {first?.printedLabel ?? start + 1}
                    {second ? ` / ${second.printedLabel ?? second.index + 1}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            className="btn secondary small"
            disabled={!canNext}
            onClick={() => setSpreadIndex((value) => value + 1)}
            aria-label="Nächste Doppelseite"
          >
            <Icon name="arrow-right" />
          </button>
        </div>

        <div className="debug-filters" aria-label="Overlayfilter">
          {KINDS.map(({ kind, label }) => (
            <button
              type="button"
              key={kind}
              className={`debug-filter ${kind}`}
              aria-pressed={visibleKinds[kind]}
              onClick={() =>
                setVisibleKinds((current) => ({ ...current, [kind]: !current[kind] }))
              }
            >
              <span className="swatch" /> {label}
            </button>
          ))}
          <button
            type="button"
            className="debug-filter label-toggle"
            aria-pressed={showLabels}
            onClick={() => setShowLabels((value) => !value)}
          >
            Labels
          </button>
        </div>

        <label className="debug-zoom">
          Zoom
          <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
            <option value={75}>75 %</option>
            <option value={100}>100 %</option>
            <option value={125}>125 %</option>
            <option value={150}>150 %</option>
          </select>
        </label>
      </div>

      <div className="debug-workbench">
        <div className="debug-spread-scroll">
          <div
            className="debug-spread"
            style={{ "--debug-zoom": `${zoom}%` } as CSSProperties}
          >
            {renderPage(leftPage, "left")}
            {renderPage(rightPage, "right")}
          </div>
        </div>

        <aside className="debug-inspector">
          {selectedArticle ? (
            <>
              <div className="debug-inspector-head">
                <span className="badge">Artikel {selectedArticle.order}</span>
                <button
                  type="button"
                  className="btn quiet small"
                  onClick={() => setSelectedArticleId(null)}
                  aria-label="Auswahl schließen"
                >
                  <Icon name="close" />
                </button>
              </div>
              <h4>{selectedArticle.title || "(ohne Titel)"}</h4>
              <dl>
                <div><dt>Status</dt><dd>{selectedArticle.reviewStatus}</dd></div>
                <div><dt>Quelle</dt><dd>{selectedArticle.source}</dd></div>
                <div><dt>Seiten</dt><dd>{selectedArticle.pageStart + 1}–{selectedArticle.pageEnd + 1}</dd></div>
                <div><dt>Zeichen</dt><dd>{selectedArticle.charCount}</dd></div>
                <div><dt>Regionen</dt><dd>{selectedArticle.regions.length}</dd></div>
                <div><dt>Bilder</dt><dd>{selectedArticle.images.length}</dd></div>
                <div><dt>Konfidenz</dt><dd>{selectedArticle.confidence ?? "—"}</dd></div>
              </dl>
              <div className="debug-block-preview">
                <span className="debug-kicker">Erkannter Text</span>
                {selectedArticle.blocks.slice(0, 4).map((block) => (
                  <p key={block._id}>
                    <span>{block.type}</span>
                    {block.text.slice(0, 180)}{block.text.length > 180 ? "…" : ""}
                  </p>
                ))}
              </div>
              {selectedArticle.images.length > 0 && (
                <div className="debug-block-preview">
                  <span className="debug-kicker">Bildzuordnung</span>
                  {selectedArticle.images.slice(0, 6).map((image) => (
                    <p key={`image-${image.order}`}>
                      <span>
                        Bild {image.order + 1}
                        {image.sourcePageIndex !== null
                          ? ` · Seite ${image.sourcePageIndex + 1}`
                          : ""}
                        {image.afterBlockOrder !== null
                          ? ` · nach Absatz ${image.afterBlockOrder}`
                          : ""}
                      </span>
                      {image.caption ?? "Keine Bildunterschrift erkannt"}
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="debug-inspector-empty">
              <Icon name="search" size={24} />
              <p>Eine farbige Fläche anklicken, um Artikel und erkannten Text zu prüfen.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
