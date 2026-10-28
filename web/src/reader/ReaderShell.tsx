import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api, TILE_SERVICE_URL, type Id } from "../lib/api";
import PageMode, { type Klickpunkt } from "./PageMode";
import { useDevtoolsWache, useKopierschutz } from "./kopierschutz";
import ArticleMode from "./ArticleMode";
import ReaderRail from "./ReaderRail";
import TocDrawer from "./TocDrawer";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";
import AppShell from "../components/AppShell";
import NichtGefunden from "../components/NichtGefunden";
import { reiheVon } from "../lib/reihen";
import { ProductChoice } from "./ShopProduct";
import { wischachse, wischziel, type Wischachse } from "./wischen";
import { artikelAufSeite } from "./artikelAufSeite";

type Mode = "page" | "article";
type PageLayout = "single" | "spread";

/** Schriftzug der Reihe fuer die Kopfleiste. Er steht dort auf einem weissen Feld. */
function reihenLogo(publicationName: string | null | undefined) {
  const reihe = reiheVon(publicationName);
  return reihe ? { ...reihe, src: reihe.hell } : null;
}

/** Ab dieser Breite steht das Inhaltsverzeichnis fest links neben dem Heft. */
const BREIT = "(min-width: 64rem)";

function useBreit() {
  const [breit, setBreit] = useState(() => window.matchMedia(BREIT).matches);
  useEffect(() => {
    const mq = window.matchMedia(BREIT);
    const onChange = () => setBreit(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return breit;
}

/** Erklaerung am Knopf "Artikelansicht", wenn ein Heft keine Artikel hat. */
const OHNE_ARTIKEL = "Für diese Ausgabe gibt es keine Artikelansicht, nur die Seiten.";

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
  const links = useQuery(api.pageLinks.forReader, { issueId });
  const productLinks = useQuery(api.articleProducts.forReader, { issueId });
  const progress = useQuery(api.progress.get, { issueId });
  const openSession = useMutation(api.readerSessions.issue);
  const saveProgress = useMutation(api.progress.save);
  const sperrenWegenDevtools = useMutation(api.readerSessions.abschluss);

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  // Schluessel zum Zusammensetzen der verwuerfelten Kacheln und Bilder.
  const [schutzKey, setSchutzKey] = useState<number | null>(null);
  const [sitzungFehler, setSitzungFehler] = useState(false);
  const [verdeckt, aufdecken] = useKopierschutz();
  // Offene Entwicklerwerkzeuge: Reader abbauen, Lesesitzung serverseitig
  // beenden. Weiter geht es erst nach dem Neuladen mit geschlossenen Werkzeugen.
  const devtools = useDevtoolsWache(access === true);
  useEffect(() => {
    if (!devtools) return;
    try {
      void navigator.clipboard?.writeText(" ");
    } catch {
      // ohne Rechte keine Zwischenablage
    }
    if (sessionToken) void sperrenWegenDevtools({ sessionToken }).catch(() => undefined);
    setSessionToken(null);
  }, [devtools, sessionToken, sperrenWegenDevtools]);
  const [watermark, setWatermark] = useState("");
  const [mode, setMode] = useState<Mode>("page");
  const [pageLayout, setPageLayout] = useState<PageLayout>(() =>
    window.localStorage.getItem("reader-page-layout") === "spread" ? "spread" : "single",
  );
  const [pageIndex, setPageIndex] = useState(0);
  const [articleId, setArticleId] = useState<Id<"articles"> | null>(null);
  // Seite, von der aus der Artikel geoeffnet wurde — der Einstieg in den
  // Lesetext. Null heisst: am Anfang des Artikels.
  const [artikelEinstieg, setArtikelEinstieg] = useState<number | null>(null);
  // Angetippter Punkt der Druckseite: die Artikelansicht springt zum Absatz
  // darunter. `n` macht einen zweiten Tipp auf dieselbe Stelle neu.
  const [einstiegPunkt, setEinstiegPunkt] = useState<
    (Klickpunkt & { articleId: Id<"articles">; n: number }) | null
  >(null);
  // Fundstelle aus der Suche (`?stelle=<Absatz>`): der Artikel oeffnet dort
  // und hebt den Absatz kurz hervor.
  const [stelle, setStelle] = useState<{ articleId: Id<"articles">; order: number } | null>(
    null,
  );
  const [tocOpen, setTocOpen] = useState(false);
  // Auf breiten Schirmen steht das Verzeichnis fest links; der Knopf "Inhalt"
  // blendet es aus und wieder ein. Die Wahl bleibt ueber Hefte hinweg.
  const breit = useBreit();
  const [tocFest, setTocFest] = useState(
    () => window.localStorage.getItem("reader-toc-fest") !== "aus",
  );
  const tocDocked = breit && tocFest;
  // Angetippte Anzeige im Seitenmodus: erst die Auswahl "bestellen oder lesen".
  const [adChoice, setAdChoice] = useState<{
    articleId: Id<"articles">;
    fromPageIndex?: number;
    punkt?: Klickpunkt;
  } | null>(null);
  // Auf dem Telefon gibt es keinen Hinweis beim Zeigen; ein Tipp auf die
  // gesperrte Artikelansicht blendet die Erklaerung kurz ein.
  const [ohneArtikelHinweis, setOhneArtikelHinweis] = useState(false);
  const ohneArtikelTimer = useRef<number | null>(null);
  const [restored, setRestored] = useState(false);
  const saveTimer = useRef<number | null>(null);
  // Die Leseflaeche als Zustand, nicht als Ref: sie entsteht erst nach dem
  // Laden, und die Wischgeste haengt sich dann an sie.
  const [leseflaeche, setLeseflaeche] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (access !== false || !issue) return;
    // Die Verkaufsseite laeuft unter `/issue/:slug`, nicht unter der Kennung.
    // Mit der Kennung landete der Leser auf "Ausgabe nicht gefunden".
    navigate(`/issue/${issue.slug}`, { replace: true });
  }, [access, issue, navigate]);

  useEffect(() => {
    if (!access) return;
    let cancelled = false;
    (async () => {
      const s = await openSession({ issueId });
      if (cancelled) return;
      // Ohne den Schluessel aus der Sitzung bleiben Kacheln und Bilder
      // verwuerfelt; der Reader wartet also auf ihn.
      for (let versuch = 0; versuch < 3 && !cancelled; versuch++) {
        try {
          const res = await fetch(`${TILE_SERVICE_URL}/api/session`, {
            headers: { "X-Tile-Session": s.token },
          });
          if (!res.ok) throw new Error(String(res.status));
          const info = await res.json();
          if (cancelled) return;
          setWatermark(info.watermark ?? "");
          setSchutzKey(Number(info.k ?? 0));
          setSessionToken(s.token);
          return;
        } catch {
          await new Promise((ok) => window.setTimeout(ok, 1500));
        }
      }
      if (!cancelled) setSitzungFehler(true);
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
      const absatz = Number(searchParams.get("stelle"));
      if (Number.isInteger(absatz) && absatz > 0) setStelle({ articleId: deepLink, order: absatz });
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
  const ohneArtikel = articles !== undefined && articles.length === 0;
  const zeigeOhneArtikel = useCallback(() => {
    setOhneArtikelHinweis(true);
    if (ohneArtikelTimer.current) window.clearTimeout(ohneArtikelTimer.current);
    ohneArtikelTimer.current = window.setTimeout(() => setOhneArtikelHinweis(false), 4000);
  }, []);
  useEffect(
    () => () => {
      if (ohneArtikelTimer.current) window.clearTimeout(ohneArtikelTimer.current);
    },
    [],
  );

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

  /**
   * Der Artikel, bei dem der Leser gerade steht; das Inhaltsverzeichnis hebt
   * ihn hervor. Im Seitenmodus ist es der zuletzt gelesene, solange er ueber
   * die aufgeschlagene Seite laeuft, sonst der erste Artikel dieser Seite —
   * derselbe, den der Wechsel in den Artikelmodus oeffnet.
   */
  const currentArticleId = useMemo(() => {
    if (mode === "article") return articleId ?? articleList[0]?._id ?? null;
    const visible = (a: { pageStart: number; pageEnd: number }) =>
      visiblePageIndexes.some((p) => p >= a.pageStart && p <= a.pageEnd);
    const opened = articleList.find((a) => a._id === articleId);
    if (opened && visible(opened)) return opened._id;
    return articleList.find(visible)?._id ?? null;
  }, [mode, articleId, articleList, visiblePageIndexes]);

  useEffect(() => {
    window.localStorage.setItem("reader-page-layout", pageLayout);
  }, [pageLayout]);

  useEffect(() => {
    window.localStorage.setItem("reader-toc-fest", tocFest ? "an" : "aus");
  }, [tocFest]);

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
    (id: Id<"articles"> | null, fromPageIndex?: number, punkt?: Klickpunkt) => {
      setArticleId(id);
      setStelle(null);
      setArtikelEinstieg(fromPageIndex ?? null);
      setEinstiegPunkt(id && punkt ? { ...punkt, articleId: id, n: Date.now() } : null);
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
      next.delete("stelle");
      setSearchParams(next, { replace: true });
      persist({ mode: "article", pageIndex: target, articleId: id });
    },
    [articleList, pageIndex, persist, searchParams, setSearchParams],
  );

  const productsByArticle = useMemo(
    () => new Map((productLinks ?? []).map((entry) => [entry.articleId, entry])),
    [productLinks],
  );

  /**
   * Tipp auf eine Artikelflaeche im Seitenmodus. Eine Anzeige mit Produkt im
   * Laden oeffnet nicht gleich ihren Text, sondern fragt erst.
   */
  const openFromPage = useCallback(
    (id: Id<"articles">, fromPageIndex?: number, punkt?: Klickpunkt) => {
      if (!productsByArticle.get(id)?.isAd) {
        openArticle(id, fromPageIndex, punkt);
        return;
      }
      // Ein Tipp erreicht die Seite auf zwei Wegen (Flaeche und Zeichenflaeche);
      // die angetippte Seite des ersten bleibt stehen.
      setAdChoice((current) =>
        current?.articleId === id
          ? {
              articleId: id,
              fromPageIndex: current.fromPageIndex ?? fromPageIndex,
              punkt: current.punkt ?? punkt,
            }
          : { articleId: id, fromPageIndex, punkt },
      );
    },
    [productsByArticle, openArticle],
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

  // Im Seitenmodus gehoert kein Artikel in die Adresse; sonst oeffnete ein
  // Neuladen wieder den alten Artikel.
  const adresseOhneArtikel = useCallback(() => {
    if (!searchParams.has("article") && !searchParams.has("stelle")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("article");
    next.delete("stelle");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const switchToPages = useCallback(() => {
    const current = articleList.find((a) => a._id === articleId);
    setMode("page");
    adresseOhneArtikel();
    // Steht der Leser schon auf einer Seite des Artikels, bleibt er dort.
    // Nur wenn die gemerkte Seite nicht zum Artikel gehoert, wird auf seinen
    // Anfang gesprungen.
    const covers =
      current != null && pageIndex >= current.pageStart && pageIndex <= current.pageEnd;
    const target = covers ? pageIndex : (current?.primaryPageIndex ?? pageIndex);
    setPageIndex(target);
    persist({ mode: "page", pageIndex: target, articleId });
  }, [articleList, articleId, pageIndex, persist, adresseOhneArtikel]);

  /**
   * Ein Eintrag im Inhaltsverzeichnis, der nur eine Seite kennt. Im
   * Artikelmodus bleibt der Leser dort und bekommt den Artikel dieser Seite;
   * nur wenn keiner sie abdeckt, geht es in den Seitenmodus.
   */
  const zuVerzeichnisSeite = useCallback(
    (p: number) => {
      const deckt = mode === "article" ? artikelAufSeite(articleList, p) : null;
      if (deckt) {
        openArticle(deckt._id, p);
        return;
      }
      setMode("page");
      adresseOhneArtikel();
      goPage(p);
    },
    [mode, articleList, openArticle, adresseOhneArtikel, goPage],
  );

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
        setAdChoice(null);
        return;
      }
      // Solange die Auswahl offen ist, blaettert nichts dahinter.
      if (adChoice) return;
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
  }, [prev, next, canPrev, canNext, adChoice]);

  // Kein Zurueck per Wischen, solange der Leser offen ist. Chromium blaettert
  // sonst bei einem Wisch nach rechts in der Browser-Geschichte zurueck, statt
  // den vorigen Artikel zu zeigen, und der Leser ist weg.
  useEffect(() => {
    const html = document.documentElement.style;
    const body = document.body.style;
    const vorher = [html.overscrollBehaviorX, body.overscrollBehaviorX];
    html.overscrollBehaviorX = "none";
    body.overscrollBehaviorX = "none";
    return () => {
      [html.overscrollBehaviorX, body.overscrollBehaviorX] = vorher;
    };
  }, []);

  // Wischen im Artikelmodus: ein Artikel vor oder zurueck. Die Bewegung wird
  // ohne `passive` verfolgt (Reacts Beruehrungsereignisse sind passiv), damit
  // eine klar seitliche Geste dem Browser genommen werden kann. Im
  // Seitenmodus gehoert die Geste dem gemeinsamen Zoom-/Pan-Viewport;
  // geblaettert wird dort ueber die Randtasten, sonst loeste horizontales
  // Verschieben einer vergroesserten Doppelseite zugleich einen Wechsel aus.
  const wischRef = useRef({ mode, prev, next });
  wischRef.current = { mode, prev, next };
  useEffect(() => {
    if (!leseflaeche) return;
    let start: { x: number; y: number } | null = null;
    let achse: Wischachse | null = null;
    const beginn = (e: TouchEvent) => {
      start = null;
      if (wischRef.current.mode === "page" || e.touches.length !== 1) return;
      // Tabellen rollen seitlich; dort gehoert die Geste ihnen.
      const ziel = e.target instanceof Element ? e.target : null;
      const rolle = ziel?.closest<HTMLElement>(".article-table");
      if (rolle && rolle.scrollWidth > rolle.clientWidth) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      achse = null;
    };
    const bewegung = (e: TouchEvent) => {
      if (!start) return;
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      achse ??= wischachse(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y);
      if (achse === "quer" && e.cancelable) e.preventDefault();
    };
    const ende = (e: TouchEvent) => {
      if (!start) return;
      const punkt = e.changedTouches[0];
      const wohin =
        achse === "hoch" ? null : wischziel(punkt.clientX - start.x, punkt.clientY - start.y);
      start = null;
      if (wohin === "zurueck") wischRef.current.prev();
      else if (wohin === "weiter") wischRef.current.next();
    };
    const abbruch = () => {
      start = null;
    };
    leseflaeche.addEventListener("touchstart", beginn, { passive: true });
    leseflaeche.addEventListener("touchmove", bewegung, { passive: false });
    leseflaeche.addEventListener("touchend", ende);
    leseflaeche.addEventListener("touchcancel", abbruch);
    return () => {
      leseflaeche.removeEventListener("touchstart", beginn);
      leseflaeche.removeEventListener("touchmove", bewegung);
      leseflaeche.removeEventListener("touchend", ende);
      leseflaeche.removeEventListener("touchcancel", abbruch);
    };
  }, [leseflaeche]);

  if (devtools) {
    return (
      <div className="centered reader-gesperrt" role="alert">
        <p>
          <strong>Die Lesesitzung wurde beendet.</strong> Bitte laden Sie die Seite neu.
        </p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Neu laden
        </button>
      </div>
    );
  }
  if (access === undefined || issue === undefined) {
    return <div className="centered">Laden...</div>;
  }
  // Unbekannt oder nicht veroeffentlicht: fuer Leser dasselbe, statt still
  // in die Bibliothek umzuleiten.
  if (!access && issue === null) {
    return (
      <AppShell>
        <NichtGefunden />
      </AppShell>
    );
  }
  if (!access) {
    return (
      <div className="centered">
        <p>Kein Zugriff auf diese Ausgabe.</p>
        <ShopHinweis />
      </div>
    );
  }

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
  const logo = reihenLogo(issue?.publicationName);

  return (
    <div
      ref={setLeseflaeche}
      className={verdeckt ? "reader-screen rv-on" : "reader-screen"}
    >
      <header className="reader-bar">
        <button className="btn quiet small" onClick={() => navigate("/library")}>
          <Icon name="arrow-left" />
          <span className="button-label">Bibliothek</span>
        </button>
        {logo && (
          <img
            className={logo.kasten ? "reader-logo kasten" : "reader-logo"}
            src={logo.src}
            alt={logo.alt}
          />
        )}
        <span className={logo ? `issue-title reihe-${logo.slug}` : "issue-title"}>
          {issue?.title}
        </span>
        <div className="mode-switch" role="group" aria-label="Ansicht">
          <button className={mode === "page" ? "active" : ""} onClick={switchToPages}>
            <Icon name="pages" />
            Seitenansicht
          </button>
          <button
            className={mode === "article" ? "active" : ""}
            onClick={ohneArtikel ? zeigeOhneArtikel : switchToArticles}
            // Solange die Liste laedt, ist der Knopf einfach gesperrt. Steht
            // fest, dass es keine Artikel gibt, bleibt er erreichbar und sagt
            // warum; ein gesperrter Knopf zeigt keinen Hinweis und nimmt
            // keinen Fokus.
            disabled={articles === undefined}
            aria-disabled={ohneArtikel || undefined}
            title={ohneArtikel ? OHNE_ARTIKEL : undefined}
          >
            <Icon name="book-open" />
            Artikelansicht
          </button>
        </div>
        {mode === "page" && (
          <div
            className="mode-switch page-layout-switch"
            role="group"
            aria-label="Seitenlayout"
          >
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
        <button
          className={tocDocked ? "btn quiet small active" : "btn quiet small"}
          aria-pressed={breit ? tocDocked : undefined}
          onClick={() => (breit ? setTocFest((f) => !f) : setTocOpen(true))}
        >
          <Icon name="list" />
          <span className="button-label">Inhalt</span>
        </button>
      </header>

      <div className={tocDocked ? "reader-body toc-fest" : "reader-body"}>
        <main className="reader-main">
          {ohneArtikelHinweis && (
            <div className="page-hint retry" role="status">
              {OHNE_ARTIKEL}
            </div>
          )}
          {mode === "page" ? (
            sessionToken && schutzKey !== null ? (
              <PageMode
                issueId={issueId}
                pageIndexes={visiblePageIndexes}
                spread={pageLayout === "spread"}
                sessionToken={sessionToken}
                schutzKey={schutzKey}
                regions={regions ?? []}
                links={links ?? []}
                watermark={watermark}
                onOpenArticle={openFromPage}
                onNavigatePage={goPage}
                onPrev={prev}
                onNext={next}
                canPrev={canPrev}
                canNext={canNext}
              />
            ) : sitzungFehler ? (
              <div className="page-hint error" role="alert">
                Lesesitzung konnte nicht geöffnet werden. Bitte Seite neu laden.
              </div>
            ) : (
              <div className="page-hint">Lesesitzung wird geöffnet...</div>
            )
          ) : (
            <ArticleMode
              articleId={articleId ?? articleList[0]?._id ?? null}
              products={
                productsByArticle.get(
                  (articleId ?? articleList[0]?._id) as Id<"articles">,
                )?.products ?? []
              }
              fromPageIndex={artikelEinstieg}
              stelle={
                stelle && stelle.articleId === (articleId ?? articleList[0]?._id)
                  ? stelle.order
                  : null
              }
              einstiegPunkt={
                einstiegPunkt && einstiegPunkt.articleId === (articleId ?? articleList[0]?._id)
                  ? einstiegPunkt
                  : null
              }
              schutzKey={schutzKey}
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

        <TocDrawer
          issueId={issueId}
          issueTitle={issue?.title}
          open={tocOpen && !tocDocked}
          docked={tocDocked}
          mode={mode}
          currentArticleId={currentArticleId}
          currentPages={mode === "page" ? visiblePageIndexes : [pageIndex]}
          pageLabel={pageLabel}
          onClose={() => (tocDocked ? setTocFest(false) : setTocOpen(false))}
          onPage={zuVerzeichnisSeite}
          onArticle={openArticle}
        />
      </div>

      <ReaderRail
        mode={mode}
        position={mode === "page" ? pageIndex : Math.max(0, articleIndex)}
        total={mode === "page" ? pageCount : articleList.length}
        label={label}
        onSeek={(p) => (mode === "page" ? goPage(p) : goArticle(p))}
      />

      {verdeckt && (
        <button type="button" className="rv" onClick={aufdecken}>
          <Icon name="book-open" />
          <span>Zum Weiterlesen hier klicken</span>
        </button>
      )}

      {adChoice && mode === "page" && (
        <ProductChoice
          products={productsByArticle.get(adChoice.articleId)?.products ?? []}
          onRead={() => {
            setAdChoice(null);
            openArticle(adChoice.articleId, adChoice.fromPageIndex, adChoice.punkt);
          }}
          onClose={() => setAdChoice(null)}
        />
      )}
    </div>
  );
}
