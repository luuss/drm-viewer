import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import ReaderTurnButton from "./ReaderTurnButton";
import ArtikelTabelle from "../components/ArtikelTabelle";
import { ShopProductLink, productKey, type ReaderProduct } from "./ShopProduct";
import { meldungsfolge } from "./meldungsfolge";
import { bildfolge } from "./bildfolge";
import {
  bildAlsCanvas,
  satzSchriften,
  schriftenAnmelden,
  schriftFamilien,
  ticketVorrat,
} from "./schutz";
import { bildschlange } from "./bildschlange";
import type { Klickpunkt } from "./PageMode";
import type { GepufferterArtikel, Paket } from "./puffer";
import { useVerbunden } from "./offline";

/**
 * Artikelbild ohne Adresse: ueber Sitzung und Einmal-Ticket geholt, im
 * Browser zusammengesetzt und auf eine Zeichenflaeche gemalt. Kein `img`,
 * also nichts fuer Bildlupen oder "Bild speichern".
 *
 * Geholt wird erst, wenn das Bild in die Naehe des sichtbaren Bereichs
 * kommt, und dann ueber die gemeinsame Warteschlange (`bildschlange.ts`):
 * wenige zugleich, oben im Artikel zuerst. `rang` ist die Stelle im Artikel.
 * Liegt es im Offline-Puffer, kommt es von dort (`stand`: Stand der Datei).
 */
function SchutzBild({
  url,
  sessionToken,
  issueId,
  schutzKey,
  puffer,
  stand,
  width,
  height,
  rang,
}: {
  url: string;
  sessionToken: string | null | undefined;
  issueId: string | null;
  schutzKey: number | null;
  puffer: Paket | null;
  stand: string | null;
  width?: number;
  height?: number;
  rang: number;
}) {
  const halter = useRef<HTMLSpanElement>(null);
  const [fertig, setFertig] = useState(false);
  // Fuer welche Adresse das Bild nah genug am Bildschirm ist. Die Knoten
  // werden beim Blaettern fuer den naechsten Artikel weiterverwendet.
  const [nahFuer, setNahFuer] = useState<string | null>(null);
  const nah = nahFuer === url;
  const rangRef = useRef(rang);
  rangRef.current = rang;
  useEffect(() => {
    const el = halter.current;
    if (!el || nah) return;
    if (typeof IntersectionObserver === "undefined") {
      setNahFuer(url);
      return;
    }
    // Der Artikel rollt in seinem eigenen Kasten; anderthalb Hoehen davor
    // und dahinter gelten als nah.
    const beobachter = new IntersectionObserver(
      (eintraege) => {
        if (eintraege.some((e) => e.isIntersecting)) setNahFuer(url);
      },
      { root: el.closest(".article-mode"), rootMargin: "150% 0px" },
    );
    beobachter.observe(el);
    return () => beobachter.disconnect();
  }, [url, nah]);
  useEffect(() => {
    const mitSitzung = !!sessionToken && schutzKey !== null;
    if (!nah || !url || !issueId || (!mitSitzung && !puffer)) return;
    const abbruch = new AbortController();
    let frei: (() => void) | null = null;
    bildschlange
      .platz(rangRef.current, abbruch.signal)
      .then((freigabe) => {
        frei = freigabe;
        return bildAlsCanvas(url, sessionToken ?? null, issueId, schutzKey, abbruch.signal, {
          paket: puffer,
          stand,
        });
      })
      .then((canvas) => {
        if (abbruch.signal.aborted || !halter.current) return;
        canvas.className = "fb-c";
        canvas.setAttribute("aria-hidden", "true");
        halter.current.replaceChildren(canvas);
        setFertig(true);
      })
      .catch(() => undefined)
      .finally(() => frei?.());
    return () => {
      abbruch.abort();
      halter.current?.replaceChildren();
      setFertig(false);
    };
  }, [nah, url, sessionToken, issueId, schutzKey, puffer, stand]);
  // Bis das Bild steht, haelt ein leerer Rahmen in Bildgroesse den Platz.
  return (
    <span
      ref={halter}
      className={fertig ? "fb" : "fb fb-p"}
      style={
        !fertig && width && height
          ? { aspectRatio: `${width} / ${height}`, maxWidth: `${width}px` }
          : undefined
      }
    />
  );
}

/**
 * Leseschriften eines Satzes (einer Lesesitzung). Der Artikeltext kommt
 * verschluesselt (`convex/schutz.ts`); erst mit der Schrift seiner Sitzung
 * wird er lesbar. Ein Text aus dem Offline-Puffer kann von einer frueheren
 * Sitzung stammen, darum hat jeder Satz eigene Familiennamen.
 */
function useSchutzSchrift(
  satz: string | null,
  quelle: {
    paket: Paket | null;
    issueId: string | null;
    sessionToken: string | null;
    liveSatz: string | null;
  },
) {
  const [bereitFuer, setBereitFuer] = useState<string | null>(null);
  const [fehlerFuer, setFehlerFuer] = useState<string | null>(null);
  const [versuch, setVersuch] = useState(0);
  const quelleRef = useRef(quelle);
  quelleRef.current = quelle;
  useEffect(() => {
    const { issueId } = quelleRef.current;
    if (!satz || !issueId) return;
    let aus = false;
    let faces: FontFace[] = [];
    setFehlerFuer(null);
    satzSchriften(satz, { ...quelleRef.current, issueId })
      .then((daten) => schriftenAnmelden(satz, daten))
      .then((geladen) => {
        if (aus) return;
        faces = geladen;
        for (const f of faces) document.fonts.add(f);
        setBereitFuer(satz);
      })
      .catch(() => {
        // Ohne Schrift ist der Text unlesbar; nicht ewig "Laden..." zeigen.
        if (!aus) setFehlerFuer(satz);
      });
    return () => {
      aus = true;
      for (const f of faces) document.fonts.delete(f);
      setBereitFuer(null);
    };
  }, [satz, versuch, quelle.issueId]);
  const stand = !satz
    ? "laedt"
    : bereitFuer === satz
      ? "bereit"
      : fehlerFuer === satz
        ? "fehler"
        : "laedt";
  return { stand, nochmal: () => setVersuch((v) => v + 1) } as const;
}

/** So lange wartet ein Artikel auf den Server, bevor er aus dem Puffer kommt. */
const GEDULD_MS = 1500;

type Props = {
  articleId: Id<"articles"> | null;
  /** Bestellbare Produkte zu Anzeigen in diesem Artikel. */
  products?: ReaderProduct[];
  /** Gedruckte Seitenzahl zu einer Leseseite (U1 statt 1 auf dem Umschlag). */
  pageLabel: (index: number) => string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  /** Lesesitzung fuer Bilder aus dem Medienspeicher. */
  sessionToken?: string | null;
  /**
   * Seite, von der aus der Artikel geoeffnet wurde. Ein langer Artikel laeuft
   * ueber viele Seiten; wer auf Seite 6 tippt, will dort weiterlesen und nicht
   * am Anfang landen.
   */
  fromPageIndex?: number | null;
  /** Angetippter Punkt der Druckseite: dorthin springt der Lesetext. */
  einstiegPunkt?: (Klickpunkt & { n: number }) | null;
  /** Absatz der Fundstelle aus der Suche (`order`): dorthin, kurz markiert. */
  stelle?: number | null;
  /** Schluessel zum Zusammensetzen der Artikelbilder. */
  schutzKey: number | null;
  /** Offline-Puffer der Ausgabe: Texte, Bilder und Schriften auch ohne Netz. */
  puffer?: Paket | null;
  /** Satz der laufenden Sitzung (`satzVon`); zu ihm passen die Texte vom Server. */
  satz?: string | null;
};

/** Fliesstext. Auf dem Telefon lesbar ohne Zoom, auf dem Schirm ruhig gesetzt. */
export default function ArticleMode({
  articleId,
  products = [],
  pageLabel,
  onPrev,
  onNext,
  canPrev,
  canNext,
  sessionToken,
  fromPageIndex,
  einstiegPunkt,
  stelle = null,
  schutzKey,
  puffer = null,
  satz = null,
}: Props) {
  // Text gibt es nur zu einer Lesesitzung, und nur verschluesselt.
  const live = useQuery(
    api.articles.getForReader,
    articleId && sessionToken ? { articleId, sessionToken } : "skip",
  );
  const verbunden = useVerbunden();

  // Derselbe Artikel aus dem Offline-Puffer, mit dem Satz seiner Schrift.
  const [gepuffert, setGepuffert] = useState<{
    id: string;
    artikel: GepufferterArtikel | null;
  } | null>(null);
  useEffect(() => {
    if (!articleId || !puffer) return;
    let aus = false;
    puffer
      .artikel(articleId)
      .catch(() => null)
      .then((artikel) => !aus && setGepuffert({ id: articleId, artikel }));
    return () => {
      aus = true;
    };
  }, [articleId, puffer]);
  const ausPuffer = puffer && gepuffert?.id === articleId ? gepuffert.artikel : null;
  const [geduldFuer, setGeduldFuer] = useState<string | null>(null);
  useEffect(() => {
    if (!articleId) return;
    const timer = window.setTimeout(() => setGeduldFuer(articleId), GEDULD_MS);
    return () => window.clearTimeout(timer);
  }, [articleId]);

  // Woher der Text kommt, steht je Artikel einmal fest: vom Server, oder aus
  // dem Puffer, wenn der Puffer schon den Text dieser Sitzung hat oder der
  // Server nicht antwortet. Ein spaeterer Wechsel taeuschte die Schrift aus
  // und warf den Leser an den Anfang zurueck.
  // Der Text aus dem Puffer bleibt fest, auch wenn das Paket inzwischen
  // ersetzt wurde.
  const wahl = useRef<
    { id: string; art: "live" } | { id: string; art: "puffer"; artikel: GepufferterArtikel } | null
  >(null);
  if (wahl.current && wahl.current.id !== articleId) wahl.current = null;
  if (!wahl.current && articleId) {
    if (live) wahl.current = { id: articleId, art: "live" };
    else if (
      ausPuffer &&
      (live === null ||
        ausPuffer.satz === satz ||
        !verbunden ||
        !sessionToken ||
        geduldFuer === articleId)
    ) {
      wahl.current = { id: articleId, art: "puffer", artikel: ausPuffer };
    } else if (live === null) wahl.current = { id: articleId, art: "live" };
  }
  const gewaehlt = wahl.current;
  const article =
    gewaehlt?.art === "puffer" ? gewaehlt.artikel.body : gewaehlt?.art === "live" ? live : undefined;
  const textSatz =
    gewaehlt?.art === "puffer" ? gewaehlt.artikel.satz : gewaehlt?.art === "live" ? satz : null;
  // Ohne Verbindung und nicht im Puffer: nicht ewig "Laden..." zeigen.
  const nichtGespeichert =
    article === undefined &&
    !verbunden &&
    geduldFuer === articleId &&
    (!puffer || (gepuffert?.id === articleId && !gepuffert.artikel));

  const schrift = useSchutzSchrift(textSatz, {
    paket: puffer,
    issueId: article?.issueId ?? null,
    sessionToken: sessionToken ?? null,
    liveSatz: satz,
  });
  // Tickets fuer die Bilder schon holen, waehrend die Schrift laedt.
  const artikelHeft = article?.issueId ?? null;
  useEffect(() => {
    if (sessionToken && artikelHeft) ticketVorrat(sessionToken, artikelHeft).vorbereiten();
  }, [sessionToken, artikelHeft]);
  const schriftBereit = schrift.stand === "bereit";
  const koerper = useRef<HTMLElement>(null);
  // Der Absatz unter dem Finger kommt vom Server; ohne Verbindung geht es
  // zur angetippten Seite im Artikel.
  const punktFrage =
    articleId && einstiegPunkt && verbunden
      ? {
          articleId,
          pageIndex: einstiegPunkt.pageIndex,
          x: einstiegPunkt.x,
          y: einstiegPunkt.y,
        }
      : ("skip" as const);
  const zielAbsatz = useQuery(api.articles.absatzBeiKlick, punktFrage);

  // An die Stelle springen, die zur angetippten Seite gehoert. Jeder Absatz
  // und jedes Bild traegt seine Druckseite; die erste Marke der Seite ist der
  // Einstieg. Auf der Anfangsseite bleibt es beim Artikelkopf. Mit einem
  // Tipppunkt geht es genauer: zum Absatz unter dem Finger.
  // Eine Fundstelle aus der Suche geht vor, ebenso genau.
  const geladen = article ?? null;
  const punktOffen =
    stelle === null && einstiegPunkt != null && punktFrage !== "skip" && zielAbsatz === undefined;
  const zielOrder = stelle ?? (zielAbsatz && einstiegPunkt ? zielAbsatz.order : null);
  // Jeder Einstieg springt einmal. Laedt der Artikel spaeter neu (die Abfrage
  // ist reaktiv), bleibt der Leser, wo er inzwischen gelesen hat.
  const gesprungen = useRef<string | null>(null);
  useEffect(() => {
    if (!geladen || !schriftBereit || punktOffen) return;
    const einstieg = `${articleId}|${zielOrder}|${einstiegPunkt?.n}|${fromPageIndex}`;
    if (gesprungen.current === einstieg) return;
    gesprungen.current = einstieg;
    const absatz =
      zielOrder !== null
        ? koerper.current?.querySelector<HTMLElement>(`[data-order="${zielOrder}"]`)
        : null;
    if (absatz) {
      absatz.scrollIntoView({ block: "center" });
      absatz.classList.remove("einstieg");
      void absatz.offsetWidth;
      absatz.classList.add("einstieg");
      return;
    }
    if (fromPageIndex == null) return;
    const ziel =
      fromPageIndex <= geladen.pageStart
        ? null
        : koerper.current?.querySelector(
            `[data-source-page="${fromPageIndex}"]`,
          );
    if (ziel) ziel.scrollIntoView({ block: "start" });
    else koerper.current?.scrollIntoView({ block: "start" });
  }, [geladen, fromPageIndex, articleId, schriftBereit, punktOffen, zielOrder, einstiegPunkt?.n]);

  if (!articleId) {
    return (
      <div className="article-mode">
        <p className="page-hint">Für diese Ausgabe sind keine Artikel freigegeben.</p>
      </div>
    );
  }
  if (article && schrift.stand === "fehler") {
    return (
      <div className="article-mode">
        <p className="page-hint err">
          Der Artikel konnte nicht geladen werden.{" "}
          <button type="button" className="btn quiet small" onClick={schrift.nochmal}>
            Erneut versuchen
          </button>
        </p>
      </div>
    );
  }
  if (nichtGespeichert) {
    return (
      <div className="article-mode">
        <p className="page-hint err">Ohne Verbindung ist dieser Artikel nicht verfügbar.</p>
      </div>
    );
  }
  if (article === undefined || (article && !schriftBereit)) {
    return <div className="article-mode"><p className="page-hint">Laden...</p></div>;
  }
  if (article === null) {
    return (
      <div className="article-mode">
        <p className="page-hint err">Artikel nicht verfügbar.</p>
      </div>
    );
  }

  // Bilder und Text werden nicht in zwei getrennten Stapeln ausgegeben. Die
  // Druckseite und die senkrechte Position aus der Extraktion ergeben eine
  // stabile Lesereihenfolge — auch bei langen, mehrseitigen Artikeln.
  const visibleBlocks = article.blocks
    .map((block, index) => ({
      kind: "block" as const,
      block,
      index,
      page: block.page ?? article.pageStart,
      y: block.sourceY ?? 0.5,
      order: index + 1,
    }))
    .filter(({ block, index }) => !(block.type === "heading" && index === 0));
  const visibleImages = article.images.map((image, index) => ({
    kind: "image" as const,
    image,
    index,
    page: image.page ?? article.pageStart,
    y: image.sourceY ?? 0.5,
    afterBlockOrder: image.afterBlockOrder ?? null,
  }));
  type FlowItem = (typeof visibleBlocks)[number] | (typeof visibleImages)[number];
  const flow: FlowItem[] = [];
  // Seiten ohne Anker und ohne Meldungen verteilen ihre Bilder gemeinsam
  // (bildfolge.ts): so kann ein Bild auch in den Text der Nachbarseite
  // ruecken, wenn seine eigene zu wenig Absaetze hat.
  let frei: { blocks: typeof visibleBlocks; images: typeof visibleImages } = {
    blocks: [],
    images: [],
  };
  const freiAbschliessen = () => {
    flow.push(...bildfolge(frei.blocks, frei.images));
    frei = { blocks: [], images: [] };
  };
  const pages = [...new Set([
    ...visibleBlocks.map((item) => item.page),
    ...visibleImages.map((item) => item.page),
  ])].sort((a, b) => a - b);
  for (const page of pages) {
    // Ein KI-geprueftes Bild traegt einen exakten Absatzanker. Nur alte,
    // ungepruefte Importe fallen auf die geometrische Seitenlogik zurueck.
    const blocks = visibleBlocks.filter((item) => item.page === page);
    const images = visibleImages
      .filter((item) => item.page === page)
      .sort((a, b) => a.y - b.y || a.index - b.index);
    const anchored = images.filter((item) => item.afterBlockOrder !== null);
    if (anchored.length) {
      const hiddenTitleOrder = article.blocks[0]?.type === "heading" ? 1 : null;
      const before = anchored.filter((item) => {
        const anchor = item.afterBlockOrder ?? 0;
        return anchor === 0 || anchor === hiddenTitleOrder;
      });
      const after = new Map<number, typeof anchored>();
      for (const image of anchored) {
        const anchor = image.afterBlockOrder ?? 0;
        if (anchor === 0 || anchor === hiddenTitleOrder) continue;
        after.set(anchor, [...(after.get(anchor) ?? []), image]);
      }
      freiAbschliessen();
      flow.push(
        ...before,
        ...blocks.flatMap((block) => [block, ...(after.get(block.order) ?? [])]),
        ...images.filter((item) => item.afterBlockOrder === null),
      );
      continue;
    }
    const meldungen = meldungsfolge(blocks, images);
    if (meldungen) {
      freiAbschliessen();
      flow.push(...meldungen);
      continue;
    }
    frei.blocks.push(...blocks);
    frei.images.push(...images);
  }
  freiAbschliessen();

  // Der Bestellknopf steht unter dem Absatz der Anzeige, zu dem er gehoert.
  // Was keinen sichtbaren Absatz findet (der Titel steht schon im Kopf), kommt
  // ans Ende des Artikels.
  const shownOrders = new Set(visibleBlocks.map((item) => item.block.order));
  const productsAfter = (order: number) =>
    products
      .filter((product) => product.blockOrder === order)
      .map((product) => <ShopProductLink key={productKey(product)} product={product} />);
  const productsAtEnd = products.filter((product) => !shownOrders.has(product.blockOrder));

  // Die Schrift der Sitzung dieses Textes (`schriftFamilien`).
  const familien = textSatz ? schriftFamilien(textSatz) : null;
  const schriftStil = familien
    ? ({ "--f0": `'${familien.f0}'`, "--f1": `'${familien.f1}'` } as CSSProperties)
    : undefined;

  return (
    <div className="article-mode gx" style={schriftStil}>
      <ReaderTurnButton
        direction="previous"
        label="Vorheriger Artikel"
        disabled={!canPrev}
        onClick={onPrev}
      />
      <ReaderTurnButton
        direction="next"
        label="Nächster Artikel"
        disabled={!canNext}
        onClick={onNext}
      />
      <article className="article-body" ref={koerper}>
        <h1>{article.title}</h1>
        {article.subtitle && <p className="subtitle">{article.subtitle}</p>}
        {article.author && <p className="byline">{article.author}</p>}
        <p className="meta">
          Seite {pageLabel(article.pageStart)}
          {article.pageEnd !== article.pageStart
            ? `–${pageLabel(article.pageEnd)}`
            : ""}
        </p>
        {flow.map((item, stelleImFluss) => {
          if (item.kind === "image") {
            const img = item.image;
            return (
              <figure key={`image-${item.index}`} data-source-page={item.page}>
                <SchutzBild
                  url={img.url ?? ""}
                  sessionToken={sessionToken}
                  issueId={article.issueId}
                  schutzKey={schutzKey}
                  puffer={puffer}
                  stand={img.stand ?? null}
                  rang={stelleImFluss}
                  // Die eigene Groesse haelt das Bild davon ab, auf
                  // Spaltenbreite hochgezogen zu werden, und haelt waehrend
                  // des Ladens den Platz frei.
                  {...(img.width && img.height
                    ? { width: img.width, height: img.height }
                    : {})}
                />
                {(img.caption || img.credit) && (
                  <figcaption>
                    {img.caption}
                    {/* Bildnachweis vom Bildrand, klein unter der Unterschrift. */}
                    {img.credit && <span className="bq">{img.credit}</span>}
                  </figcaption>
                )}
              </figure>
            );
          }
          const b = item.block;
          const key = `block-${item.index}`;
          // Ein Kasten oder Zitat, das schon im Fliesstext steht, faellt weg
          // (`zitatDoppelt`); Bilder und Bestellknoepfe dahinter bleiben.
          const block = b.doppelt ? null : b.type === "heading" || b.type === "subheading" ? (
              <h2 data-source-page={item.page} data-order={b.order}>{b.text}</h2>
            ) : b.type === "box" ? (
              // Kasten aus dem Heft (Info-, Zitatkasten): abgesetzt vom
              // Fliesstext. Mehrere Absaetze eines Kastens stehen beisammen.
              <aside className="kasten" data-source-page={item.page} data-order={b.order}>
                {b.text}
              </aside>
            ) : b.type === "quote" ? (
              <blockquote data-source-page={item.page} data-order={b.order}>{b.text}</blockquote>
            ) : b.type === "lead" ? (
              <p className="lead" data-source-page={item.page} data-order={b.order}>{b.text}</p>
            ) : b.type === "question" ? (
              // Interviewfrage: im Druck kursiv abgesetzt.
              <p className="fq" data-source-page={item.page} data-order={b.order}>{b.text}</p>
            ) : b.type === "table" && b.table ? (
              <ArtikelTabelle table={b.table} sourcePage={item.page} order={b.order} />
            ) : b.type === "caption" ? (
              <p className="caption" data-source-page={item.page} data-order={b.order}>{b.text}</p>
            ) : (
              <p data-source-page={item.page} data-order={b.order}>{b.text}</p>
            );
          return (
            <Fragment key={key}>
              {block}
              {productsAfter(b.order)}
            </Fragment>
          );
        })}
        {productsAtEnd.map((product) => (
          <ShopProductLink key={productKey(product)} product={product} />
        ))}
      </article>
    </div>
  );
}
