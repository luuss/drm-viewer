import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api, TILE_SERVICE_URL, type Id } from "../lib/api";
import PageMode from "./PageMode";
import ArticleMode from "./ArticleMode";
import ReaderRail from "./ReaderRail";
import TocDrawer from "./TocDrawer";
import Icon from "../components/Icon";

type Mode = "page" | "article";
type PageLayout = "single" | "spread";

/** Umschlag allein, danach echte linke/rechte Magazinpaare. */
function spreadStart(index: number) {
  if (index <= 0) return 0;
  return index % 2 === 1 ? index : index - 1;
}

/**
 * Rahmen des Readers: Modus, Navigation, Lesefortschritt, Inhaltsverzeichnis.
 *
 * Zwei gleichwertige Modi. Im Seitenmodus bedeutet Blaettern eine Seite, im
 * Artikelmodus einen Artikel — Tastatur, Wischen und Regler folgen demselben
 * Verstaendnis.
 */
export default function ReaderShell() {
  const { issueId: issueParam } = useParams();
  const issueId = issueParam as Id<"issues">;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const access = useQuery(api.issues.hasAccess, { issueId });
  const issue = useQuery(api.issues.getPublic, { issueId });
  const pages = useQuery(api.issuePages.listForReader, { issueId });
  const articles = useQuery(api.articles.listForReader, { issueId });
  const regions = useQuery(api.articles.regionsForReader, { issueId });
  const progress = useQuery(api.progress.get, { issueId });
  const openSession = useMutation(api.readerSessions.issue);
  const saveProgress = useMutation(api.progress.save);

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [watermark, setWatermark] = useState("");
  const [mode, setMode] = useState<Mode>("page");
  const [pageLayout, setPageLayout] = useState<PageLayout>(() =>
    window.localStorage.getItem("reader-page-layout") === "spread"
      ? "spread"
      : "single",
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [articleId, setArticleId] = useState<Id<"articles"> | null>(null);
  // Seite, von der aus der Artikel geoeffnet wurde — der Einstieg in den
  // Lesetext. Null heisst: am Anfang des Artikels.
  const [artikelEinstieg, setArtikelEinstieg] = useState<number | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (access !== false || issue === undefined) return;
    // Die Verkaufsseite laeuft unter `/issue/:slug`, nicht unter der Kennung.
    // Mit der Kennung landete der Leser auf "Ausgabe nicht gefunden".
    navigate(issue?.slug ? `/issue/${issue.slug}` : "/library", { replace: true });
  }, [access, issue, navigate]);

  useEffect(() => {
    if (!access) return;
    let cancelled = false;
    (async () => {
      const s = await openSession({ issueId });
      if (cancelled) return;
      setSessionToken(s.token);
      try {
        const res = await fetch(`${TILE_SERVICE_URL}/api/session`, {
          headers: { "X-Tile-Session": s.token },
        });
        if (res.ok) setWatermark((await res.json()).watermark ?? "");
      } catch {
        // Wasserzeichen ist Beiwerk, kein Grund den Reader zu blockieren.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [access, issueId, openSession]);

  // Letzte Position wiederherstellen, sonst Seite 1 im Seitenmodus.
  useEffect(() => {
    if (restored || progress === undefined || articles === undefined) return;
    const deepLink = searchParams.get("article") as Id<"articles"> | null;
    if (deepLink && articles.some((a) => a._id === deepLink)) {
      setMode("article");
      setArticleId(deepLink);
      const hit = articles.find((a) => a._id === deepLink);
      if (hit) setPageIndex(hit.primaryPageIndex);
    } else if (progress) {
      setMode(progress.mode);
      setPageIndex(progress.pageIndex);
      setArticleId((progress.articleId as Id<"articles"> | null) ?? null);
    }
    setRestored(true);
  }, [restored, progress, articles, searchParams]);

  const articleList = articles ?? [];

  /**
   * Die gedruckte Seitenzahl zu einer Leseseite. Sie ist nicht die laufende
   * Nummer: der Umschlag heisst U1 bis U4, und der Innenteil beginnt bei 3.
   * Ohne sie stand am Artikel "Seite 1", wo im Heft "U1" steht.
   */
  const pageLabel = useCallback(
    (index: number) =>
      pages?.find((p) => p.index === index)?.printedLabel || String(index + 1),
    [pages],
  );

  const articleIndex = useMemo(
    () => articleList.findIndex((a) => a._id === articleId),
    [articleList, articleId],
  );
  const pageCount = pages?.length ?? issue?.pageCount ?? 0;
  const visiblePageIndexes = useMemo(() => {
    if (pageLayout === "single") return [pageIndex];
    const start = spreadStart(pageIndex);
    // Der Titel ist bei einem echten Heft die alleinstehende rechte Seite.
    // U2 beginnt erst die naechste Doppelseite und darf nicht zweimal erscheinen.
    if (start === 0) return [0];
    return start + 1 < pageCount ? [start, start + 1] : [start];
  }, [pageLayout, pageIndex, pageCount]);

  useEffect(() => {
    window.localStorage.setItem("reader-page-layout", pageLayout);
  }, [pageLayout]);

  const persist = useCallback(
    (next: { mode: Mode; pageIndex: number; articleId: Id<"articles"> | null }) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      // Gedrosselt schreiben, nicht bei jedem Blaettern sofort.
      saveTimer.current = window.setTimeout(() => {
        void saveProgress({
          issueId,
          mode: next.mode,
          pageIndex: next.pageIndex,
          articleId: next.articleId ?? undefined,
        });
      }, 1200);
    },
    [issueId, saveProgress],
  );

  const goPage = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, Math.max(0, pageCount - 1)));
      setPageIndex(clamped);
      persist({ mode: "page", pageIndex: clamped, articleId });
    },
    [pageCount, persist, articleId],
  );

  const openArticle = useCallback(
    (id: Id<"articles"> | null, fromPageIndex?: number) => {
      setArticleId(id);
      setArtikelEinstieg(fromPageIndex ?? null);
      setMode("article");
      const hit = articleList.find((a) => a._id === id);
      // Laeuft der Artikel ueber die Seite, auf der der Leser gerade steht,
      // bleibt diese Seite stehen. Sonst sprang der Rueckwechsel in den
      // Seitenmodus auf den Anfang des Artikels zurueck, obwohl der Leser
      // schon weiter war.
      const covers =
        hit != null && pageIndex >= hit.pageStart && pageIndex <= hit.pageEnd;
      const target = covers ? pageIndex : (hit?.primaryPageIndex ?? pageIndex);
      setPageIndex(target);
      const next = new URLSearchParams(searchParams);
      if (id) next.set("article", id as string);
      else next.delete("article");
      setSearchParams(next, { replace: true });
      persist({ mode: "article", pageIndex: target, articleId: id });
    },
    [articleList, pageIndex, persist, searchParams, setSearchParams],
  );

  const goArticle = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, articleList.length - 1));
      const target = articleList[clamped];
      if (target) openArticle(target._id);
    },
    [articleList, openArticle],
  );

  /** Ohne geklickten Artikel den wahrscheinlichsten auf der Seite oeffnen. */
  const switchToArticles = useCallback(() => {
    if (articleList.length === 0) return;
    const onPage = articleList.find(
      (a) => pageIndex >= a.pageStart && pageIndex <= a.pageEnd,
    );
    const nearest =
      onPage ??
      articleList.reduce((best, a) =>
        Math.abs(a.primaryPageIndex - pageIndex) <
        Math.abs(best.primaryPageIndex - pageIndex)
          ? a
          : best,
      );
    // Auch hier steigt der Leser dort ein, wo er gerade steht.
    openArticle(nearest._id, pageIndex);
  }, [articleList, pageIndex, openArticle]);

  const switchToPages = useCallback(() => {
    const current = articleList.find((a) => a._id === articleId);
    setMode("page");
    // Steht der Leser schon auf einer Seite des Artikels, bleibt er dort.
    // Nur wenn die gemerkte Seite nicht zum Artikel gehoert, wird auf seinen
    // Anfang gesprungen.
    const covers =
      current != null &&
      pageIndex >= current.pageStart &&
      pageIndex <= current.pageEnd;
    const target = covers ? pageIndex : (current?.primaryPageIndex ?? pageIndex);
    setPageIndex(target);
    persist({ mode: "page", pageIndex: target, articleId });
  }, [articleList, articleId, pageIndex, persist]);

  const prev = useCallback(() => {
    if (mode === "article") {
      goArticle(articleIndex - 1);
      return;
    }
    if (pageLayout === "single") {
      goPage(pageIndex - 1);
      return;
    }
    const start = spreadStart(pageIndex);
    goPage(start <= 1 ? 0 : start - 2);
  }, [mode, pageLayout, pageIndex, articleIndex, goPage, goArticle]);

  const next = useCallback(() => {
    if (mode === "article") {
      goArticle(articleIndex + 1);
      return;
    }
    if (pageLayout === "single") {
      goPage(pageIndex + 1);
      return;
    }
    const start = spreadStart(pageIndex);
    goPage(start === 0 ? 1 : start + 2);
  }, [mode, pageLayout, pageIndex, articleIndex, goPage, goArticle]);

  const canPrev =
    mode === "page"
      ? pageLayout === "spread"
        ? spreadStart(pageIndex) > 0
        : pageIndex > 0
      : articleIndex > 0;
  const canNext =
    mode === "page"
      ? pageLayout === "spread"
        ? visiblePageIndexes[visiblePageIndexes.length - 1] < pageCount - 1
        : pageIndex < pageCount - 1
      : articleIndex >= 0 && articleIndex < articleList.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTocOpen(false);
        return;
      }
      // Liegt der Fokus auf einem Bedienelement — vor allem auf dem Regler der
      // unteren Leiste —, gehoert die Pfeiltaste diesem Element. Sonst blaettert
      // ein einziger Tastendruck zwei Seiten weiter.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

      // Die Pfeile sind ausschliesslich Blaettertasten. In der Capture-Phase
      // stoppen wir das Ereignis vor OpenSeadragon; gehaltene Tasten springen
      // nicht unkontrolliert ueber mehrere Seiten.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === "ArrowLeft" && canPrev) prev();
      if (e.key === "ArrowRight" && canNext) next();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prev, next, canPrev, canNext]);

  if (access === undefined || issue === undefined) {
    return <div className="centered">Laden...</div>;
  }
  if (!access) return <div className="centered">Kein Zugriff auf diese Ausgabe.</div>;

  // Im Seitenmodus zaehlt die untere Leiste schon die laufende Nummer. Die
  // gedruckte Seitenzahl kommt nur dazu, wenn sie davon abweicht — auf dem
  // Umschlag steht U1, nicht 1. Sonst stand dort zweimal dieselbe Zahl.
  const printed = pages?.[pageIndex]?.printedLabel ?? "";
  const label =
    mode === "page"
      ? pageLayout === "spread"
        ? visiblePageIndexes.map(pageLabel).join("–")
        : printed === String(pageIndex + 1)
          ? ""
          : printed
      : (articleList[articleIndex]?.title ?? "").slice(0, 40);

  return (
    <div
      className="reader-screen"
      onTouchStart={(e) => {
        // Im Seitenmodus gehoert die Geste dem gemeinsamen Zoom-/Pan-Viewport.
        // Geblaettert wird dort ueber die Randtasten; sonst loest horizontales
        // Verschieben einer vergroesserten Doppelseite zugleich einen Wechsel aus.
        if (mode === "page") return;
        touchStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
      }}
      onTouchEnd={(e) => {
        if (mode === "page") {
          touchStart.current = null;
          return;
        }
        const start = touchStart.current;
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx > 0) prev();
          else next();
        }
        touchStart.current = null;
      }}
    >
      <header className="reader-bar">
        <button className="btn quiet small" onClick={() => navigate("/library")}>
          <Icon name="arrow-left" />
          <span className="button-label">Bibliothek</span>
        </button>
        <span className="issue-title">{issue?.title}</span>
        <div className="mode-switch" role="group" aria-label="Ansicht">
          <button
            className={mode === "page" ? "active" : ""}
            onClick={switchToPages}
          >
            <Icon name="pages" />
            Seiten
          </button>
          <button
            className={mode === "article" ? "active" : ""}
            onClick={switchToArticles}
            disabled={articleList.length === 0}
          >
            <Icon name="book-open" />
            Artikel
          </button>
        </div>
        {mode === "page" && (
          <div className="mode-switch page-layout-switch" role="group" aria-label="Seitenlayout">
            <button
              className={pageLayout === "single" ? "active" : ""}
              onClick={() => setPageLayout("single")}
              aria-pressed={pageLayout === "single"}
              aria-label="Einzelseite anzeigen"
              title="Einzelseite"
            >
              <Icon name="pages" />
              <span>1</span>
            </button>
            <button
              className={pageLayout === "spread" ? "active" : ""}
              onClick={() => setPageLayout("spread")}
              aria-pressed={pageLayout === "spread"}
              aria-label="Doppelseite anzeigen"
              title="Doppelseite"
            >
              <Icon name="spread" />
              <span>2</span>
            </button>
          </div>
        )}
        <button className="btn quiet small" onClick={() => setTocOpen(true)}>
          <Icon name="list" />
          <span className="button-label">Inhalt</span>
        </button>
      </header>

      <main className="reader-main">
        {mode === "page" ? (
          sessionToken ? (
            <PageMode
              issueId={issueId}
              pageIndexes={visiblePageIndexes}
              spread={pageLayout === "spread"}
              sessionToken={sessionToken}
              regions={regions ?? []}
              watermark={watermark}
              onOpenArticle={openArticle}
              onNavigatePage={goPage}
              onPrev={prev}
              onNext={next}
              canPrev={canPrev}
              canNext={canNext}
            />
          ) : (
            <div className="page-hint">Lesesitzung wird geöffnet...</div>
          )
        ) : (
          <ArticleMode
            articleId={articleId ?? articleList[0]?._id ?? null}
            fromPageIndex={artikelEinstieg}
            watermark={watermark}
            pageLabel={pageLabel}
            onPrev={prev}
            onNext={next}
            canPrev={canPrev}
            canNext={canNext}
            sessionToken={sessionToken}
          />
        )}
      </main>

      <ReaderRail
        mode={mode}
        position={mode === "page" ? pageIndex : Math.max(0, articleIndex)}
        total={mode === "page" ? pageCount : articleList.length}
        label={label}
        onSeek={(p) => (mode === "page" ? goPage(p) : goArticle(p))}
      />

      <TocDrawer
        issueId={issueId}
        open={tocOpen}
        mode={mode}
        pageLabel={pageLabel}
        onClose={() => setTocOpen(false)}
        onPage={(p) => {
          setMode("page");
          goPage(p);
        }}
        onArticle={openArticle}
      />
    </div>
  );
}
