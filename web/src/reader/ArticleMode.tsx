import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import ReaderTurnButton from "./ReaderTurnButton";
import ArtikelTabelle from "../components/ArtikelTabelle";
import { ShopProductLink, productKey, type ReaderProduct } from "./ShopProduct";
import { meldungsfolge } from "./meldungsfolge";
import { bildfolge } from "./bildfolge";
import { bildAlsCanvas, schriftenLaden } from "./schutz";
import type { Klickpunkt } from "./PageMode";

/**
 * Artikelbild ohne Adresse: ueber Sitzung und Einmal-Ticket geholt, im
 * Browser zusammengesetzt und auf eine Zeichenflaeche gemalt. Kein `img`,
 * also nichts fuer Bildlupen oder "Bild speichern".
 */
function SchutzBild({
  url,
  sessionToken,
  issueId,
  schutzKey,
  width,
  height,
}: {
  url: string;
  sessionToken: string | null | undefined;
  issueId: string | null;
  schutzKey: number | null;
  width?: number;
  height?: number;
}) {
  const halter = useRef<HTMLSpanElement>(null);
  const [fertig, setFertig] = useState(false);
  useEffect(() => {
    if (!url || !sessionToken || !issueId || schutzKey === null) return;
    const abbruch = new AbortController();
    bildAlsCanvas(url, sessionToken, issueId, schutzKey, abbruch.signal)
      .then((canvas) => {
        if (abbruch.signal.aborted || !halter.current) return;
        canvas.className = "fb-c";
        canvas.setAttribute("aria-hidden", "true");
        halter.current.replaceChildren(canvas);
        setFertig(true);
      })
      .catch(() => undefined);
    return () => {
      abbruch.abort();
      halter.current?.replaceChildren();
      setFertig(false);
    };
  }, [url, sessionToken, issueId, schutzKey]);
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
 * Leseschriften der Sitzung. Der Artikeltext kommt verschluesselt
 * (`convex/schutz.ts`); erst mit diesen Schriften wird er lesbar.
 */
function useSchutzSchrift(sessionToken: string | null | undefined, issueId: string | null) {
  const [stand, setStand] = useState<"laedt" | "bereit" | "fehler">("laedt");
  const [versuch, setVersuch] = useState(0);
  useEffect(() => {
    if (!sessionToken || !issueId) return;
    const abbruch = new AbortController();
    let faces: FontFace[] = [];
    setStand("laedt");
    schriftenLaden(sessionToken, issueId, abbruch.signal)
      .then((geladen) => {
        if (abbruch.signal.aborted) return;
        faces = geladen;
        for (const f of faces) document.fonts.add(f);
        setStand("bereit");
      })
      .catch(() => {
        // Ohne Schrift ist der Text unlesbar; nicht ewig "Laden..." zeigen.
        if (!abbruch.signal.aborted) setStand("fehler");
      });
    return () => {
      abbruch.abort();
      for (const f of faces) document.fonts.delete(f);
    };
  }, [sessionToken, issueId, versuch]);
  return { stand, nochmal: () => setVersuch((v) => v + 1) };
}

type Props = {
  articleId: Id<"articles"> | null;
  /** Bestellbare Produkte zu Anzeigen in diesem Artikel. */
  products?: ReaderProduct[];
  watermark: string;
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
};

/** Fliesstext. Auf dem Telefon lesbar ohne Zoom, auf dem Schirm ruhig gesetzt. */
export default function ArticleMode({
  articleId,
  products = [],
  watermark,
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
}: Props) {
  // Text gibt es nur zu einer Lesesitzung, und nur verschluesselt.
  const article = useQuery(
    api.articles.getForReader,
    articleId && sessionToken ? { articleId, sessionToken } : "skip",
  );
  const schrift = useSchutzSchrift(sessionToken, article?.issueId ?? null);
  const schriftBereit = schrift.stand === "bereit";
  const koerper = useRef<HTMLElement>(null);
  const zielAbsatz = useQuery(
    api.articles.absatzBeiKlick,
    articleId && einstiegPunkt
      ? {
          articleId,
          pageIndex: einstiegPunkt.pageIndex,
          x: einstiegPunkt.x,
          y: einstiegPunkt.y,
        }
      : "skip",
  );

  // An die Stelle springen, die zur angetippten Seite gehoert. Jeder Absatz
  // und jedes Bild traegt seine Druckseite; die erste Marke der Seite ist der
  // Einstieg. Auf der Anfangsseite bleibt es beim Artikelkopf. Mit einem
  // Tipppunkt geht es genauer: zum Absatz unter dem Finger.
  // Eine Fundstelle aus der Suche geht vor, ebenso genau.
  const geladen = article ?? null;
  const punktOffen = stelle === null && einstiegPunkt != null && zielAbsatz === undefined;
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

  return (
    <div className="article-mode gx">
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
        {flow.map((item) => {
          if (item.kind === "image") {
            const img = item.image;
            return (
              <figure key={`image-${item.index}`} data-source-page={item.page}>
                <SchutzBild
                  url={img.url ?? ""}
                  sessionToken={sessionToken}
                  issueId={article.issueId}
                  schutzKey={schutzKey}
                  // Die eigene Groesse haelt das Bild davon ab, auf
                  // Spaltenbreite hochgezogen zu werden, und haelt waehrend
                  // des Ladens den Platz frei.
                  {...(img.width && img.height
                    ? { width: img.width, height: img.height }
                    : {})}
                />
                {img.caption && <figcaption>{img.caption}</figcaption>}
              </figure>
            );
          }
          const b = item.block;
          const key = `block-${item.index}`;
          const block =
            b.type === "heading" || b.type === "subheading" ? (
              <h2 data-source-page={item.page} data-order={b.order}>{b.text}</h2>
            ) : b.type === "quote" ? (
              <blockquote data-source-page={item.page} data-order={b.order}>{b.text}</blockquote>
            ) : b.type === "lead" ? (
              <p className="lead" data-source-page={item.page} data-order={b.order}>{b.text}</p>
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
      {watermark && <div className="watermark">{watermark}</div>}
    </div>
  );
}
