import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/convex";
import { fetchTile, fetchTokens, fireDecoy } from "../reader/tileClient";
import { applyInvisibleWatermark, drawNoise } from "../reader/drm";

const GRID = 6;

export default function ReaderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const bookId = id as Id<"books">;

  const owned = useQuery(api.books.hasEntitlement, { bookId });
  const book = useQuery(api.books.getBook, { bookId });
  const progress = useQuery(api.progress.get, { bookId });
  const saveProgress = useMutation(api.progress.save);
  const issueSession = useMutation(api.tileSessions.issue);

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number | null>(null);
  const [spread, setSpread] = useState(false);
  const [loading, setLoading] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const sessionId = useMemo(() => crypto.randomUUID(), []);

  const gridRef = useRef<HTMLDivElement>(null);
  const noiseRef = useRef<HTMLCanvasElement>(null);
  const copyGuardRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const progressTimer = useRef<number | null>(null);
  const noiseInterval = useRef<number | null>(null);

  useEffect(() => {
    if (owned === false) {
      navigate(`/book/${bookId}`);
    }
  }, [owned, bookId, navigate]);

  useEffect(() => {
    if (!owned) return;
    let cancelled = false;
    (async () => {
      const s = await issueSession({ bookId });
      if (!cancelled) setSessionToken(s.token);
    })();
    return () => {
      cancelled = true;
    };
  }, [owned, bookId, issueSession]);

  useEffect(() => {
    if (progress !== undefined && currentPage === null) {
      setCurrentPage(progress ?? 0);
    }
  }, [progress, currentPage]);

  const totalPages = book?.pageCount ?? 0;

  useEffect(() => {
    if (!sessionToken || currentPage === null || !book) return;
    void renderPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken, currentPage, spread, book?.pageCount]);

  useEffect(() => {
    return () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
      if (noiseInterval.current) clearInterval(noiseInterval.current);
    };
  }, []);

  async function renderSingle(page: number, into: HTMLElement) {
    if (!sessionToken) return;
    const bundle = await fetchTokens(sessionToken, bookId, page);

    into.style.display = "grid";
    into.style.gridTemplateColumns = `repeat(${GRID}, 1fr)`;
    into.style.gridTemplateRows = `repeat(${GRID}, 1fr)`;

    // Pre-size canvases so grid doesn't pop when images arrive.
    const expectedTileW = book?.pageWidth ? Math.floor(book.pageWidth / GRID) : 0;
    const expectedTileH = book?.pageHeight ? Math.floor(book.pageHeight / GRID) : 0;

    type Tile = { r: number; c: number; token: string };
    const tiles: Tile[] = [];
    for (let r = 0; r < GRID; r++)
      for (let c = 0; c < GRID; c++)
        tiles.push({ r, c, token: bundle.tokens[`${r}_${c}`] });

    const domOrder = [...tiles].sort(() => Math.random() - 0.5);
    const canvasMap: Record<string, HTMLCanvasElement> = {};
    for (const t of domOrder) {
      const canvas = document.createElement("canvas");
      canvas.style.gridRow = `${t.r + 1}`;
      canvas.style.gridColumn = `${t.c + 1}`;
      if (expectedTileW && expectedTileH) {
        canvas.width = expectedTileW;
        canvas.height = expectedTileH;
      }
      into.appendChild(canvas);
      canvasMap[`${t.r}_${t.c}`] = canvas;
    }

    for (const d of bundle.decoys) fireDecoy(sessionToken, d);

    const fetchOrder = [...tiles].sort(() => Math.random() - 0.5);
    await Promise.all(
      fetchOrder.map(async (t) => {
        try {
          const blob = await fetchTile(
            sessionToken,
            bookId,
            page,
            t.r,
            t.c,
            t.token,
          );
          const blobUrl = URL.createObjectURL(blob);
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const canvas = canvasMap[`${t.r}_${t.c}`];
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(img, 0, 0);
              applyInvisibleWatermark(
                ctx,
                canvas.width,
                canvas.height,
                sessionId,
                t.r,
                t.c,
              );
              URL.revokeObjectURL(blobUrl);
              img.src = "";
              resolve();
            };
            img.onerror = () => resolve();
            img.src = blobUrl;
          });
        } catch (err) {
          console.warn("tile fetch error", err);
        }
      }),
    );
  }

  async function renderPage() {
    if (!gridRef.current || currentPage === null) return;
    setLoading(true);
    setRenderError(null);
    if (totalPages === 0) {
      setLoading(false);
      setRenderError("Dieses Buch hat 0 Seiten und kann nicht angezeigt werden. Bitte im Admin-Bereich löschen und neu hochladen.");
      return;
    }
    const container = gridRef.current;
    container.innerHTML = "";
    container.removeAttribute("style");

    try {
    if (spread) {
      container.classList.add("spread");
      const left = document.createElement("div");
      left.className = "spread-page";
      container.appendChild(left);
      const jobs = [renderSingle(currentPage, left)];
      const right = currentPage + 1;
      if (right < totalPages) {
        const r = document.createElement("div");
        r.className = "spread-page";
        container.appendChild(r);
        jobs.push(renderSingle(right, r));
      }
      // Size container with known dims immediately.
      fitGrid();
      await Promise.all(jobs);
    } else {
      container.classList.remove("spread");
      const renderJob = renderSingle(currentPage, container);
      // Give the appended canvases a micro-tick to mount, then size.
      await Promise.resolve();
      requestAnimationFrame(() => fitGrid());
      await renderJob;
    }

    fitGrid();
    if (noiseRef.current) drawNoise(noiseRef.current);
    if (noiseInterval.current) clearInterval(noiseInterval.current);
    noiseInterval.current = window.setInterval(() => {
      if (noiseRef.current) drawNoise(noiseRef.current);
    }, 1500);

    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => {
      saveProgress({ bookId, page: currentPage! }).catch(() => {});
    }, 500);
    } catch (e: any) {
      console.error("renderPage failed", e);
      setRenderError(e?.message || "Fehler beim Laden der Seite");
    }

    setLoading(false);
  }

  function fitGrid() {
    const container = gridRef.current;
    const viewport = viewportRef.current;
    const noise = noiseRef.current;
    const guard = copyGuardRef.current;
    if (!container || !viewport || !noise || !guard) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight - 10;

    const fallbackW = book?.pageWidth ?? 0;
    const fallbackH = book?.pageHeight ?? 0;

    if (spread) {
      const pages = container.querySelectorAll<HTMLElement>(".spread-page");
      const firstCanvas = pages[0]?.querySelector("canvas");
      const pageW = firstCanvas?.width
        ? firstCanvas.width * GRID
        : fallbackW;
      const pageH = firstCanvas?.height
        ? firstCanvas.height * GRID
        : fallbackH;
      if (!pageW || !pageH) return;
      const totalW = pageW * pages.length;
      const scale = Math.min(vw / totalW, vh / pageH, 1);
      const scaledPageW = pageW * scale;
      const scaledH = pageH * scale;
      pages.forEach((p) => {
        p.style.width = scaledPageW + "px";
        p.style.height = scaledH + "px";
      });
      container.style.width = scaledPageW * pages.length + "px";
      container.style.height = scaledH + "px";
      noise.width = Math.round(scaledPageW * pages.length);
      noise.height = Math.round(scaledH);
    } else {
      const firstCanvas = container.querySelector("canvas");
      const totalW = firstCanvas?.width
        ? firstCanvas.width * GRID
        : fallbackW;
      const totalH = firstCanvas?.height
        ? firstCanvas.height * GRID
        : fallbackH;
      if (!totalW || !totalH) return;
      const scale = Math.min(vw / totalW, vh / totalH, 1);
      container.style.width = totalW * scale + "px";
      container.style.height = totalH * scale + "px";
      container.style.gridTemplateColumns = `repeat(${GRID}, 1fr)`;
      container.style.gridTemplateRows = `repeat(${GRID}, 1fr)`;
      noise.width = Math.round(totalW * scale);
      noise.height = Math.round(totalH * scale);
    }
    noise.style.width = container.style.width;
    noise.style.height = container.style.height;
    guard.style.width = container.style.width;
    guard.style.height = container.style.height;
  }

  useEffect(() => {
    const onResize = () => {
      fitGrid();
      if (noiseRef.current) drawNoise(noiseRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spread]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        next();
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      if ((e.ctrlKey || e.metaKey) && ["s", "p", "u"].includes(e.key)) e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && "iIjJcC".includes(e.key))
        e.preventDefault();
      if (e.key === "F12") e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "PrintScreen") {
        clearAllTiles();
        setTimeout(() => void renderPage(), 500);
      }
    };
    const onCtx = (e: Event) => e.preventDefault();
    const onDrag = (e: Event) => e.preventDefault();
    const onVis = () => {
      if (gridRef.current)
        gridRef.current.style.filter = document.hidden
          ? "blur(30px) brightness(0.3)"
          : "";
    };
    const onBlur = () => {
      if (gridRef.current)
        gridRef.current.style.filter = "blur(30px) brightness(0.3)";
    };
    const onFocus = () => {
      if (gridRef.current) gridRef.current.style.filter = "";
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("dragstart", onDrag);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    const devtoolsTimer = window.setInterval(() => {
      const w = window.outerWidth - window.innerWidth > 160;
      const h = window.outerHeight - window.innerHeight > 160;
      if (w || h) clearAllTiles();
    }, 1000);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("dragstart", onDrag);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      clearInterval(devtoolsTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, spread]);

  function clearAllTiles() {
    document
      .querySelectorAll<HTMLCanvasElement>("#tile-grid canvas, .spread-page canvas")
      .forEach((c) => {
        c.width = c.width;
      });
  }

  function next() {
    if (currentPage === null) return;
    const step = spread ? 2 : 1;
    if (currentPage + step < totalPages) setCurrentPage(currentPage + step);
  }
  function prev() {
    if (currentPage === null) return;
    const step = spread ? 2 : 1;
    setCurrentPage(Math.max(0, currentPage - step));
  }
  function toggleSpread() {
    if (currentPage !== null && !spread && currentPage % 2 !== 0) {
      setCurrentPage(currentPage - 1);
    }
    setSpread((s) => !s);
  }
  function toggleFullscreen() {
    const el = document.getElementById("reader-screen");
    if (!document.fullscreenElement) el?.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  }

  if (owned === undefined || book === undefined)
    return <div className="centered">Laden...</div>;

  const pageLabel =
    currentPage === null
      ? "-"
      : spread
      ? currentPage + 1 === Math.min(currentPage + 1, totalPages - 1) + 1
        ? `Seite ${currentPage + 1} / ${totalPages}`
        : `Seite ${currentPage + 1}–${Math.min(currentPage + 2, totalPages)} / ${totalPages}`
      : `Seite ${(currentPage ?? 0) + 1} / ${totalPages}`;

  return (
    <div id="reader-screen" className="reader-screen">
      <div className="reader-toolbar">
        <button onClick={() => navigate("/library")}>Zurück</button>
        <button onClick={prev} disabled={currentPage === null || currentPage <= 0}>
          ◀
        </button>
        <span className="page-info">{pageLabel}</span>
        <button
          onClick={next}
          disabled={
            currentPage === null ||
            (spread ? currentPage + 2 >= totalPages : currentPage >= totalPages - 1)
          }
        >
          ▶
        </button>
        <button onClick={toggleSpread}>{spread ? "Einzelseite" : "Doppelseite"}</button>
        <button onClick={toggleFullscreen}>Vollbild</button>
      </div>
      <div className="reader-viewport" ref={viewportRef}>
        <div id="tile-grid" ref={gridRef} />
        <canvas id="noise-overlay" ref={noiseRef} />
        <div id="copy-guard" ref={copyGuardRef} />
        {loading && <div className="loading">Laden...</div>}
        {renderError && !loading && (
          <div className="reader-error">
            <p>{renderError}</p>
            <button className="btn secondary" onClick={() => navigate("/library")}>
              Zurück zur Bibliothek
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
