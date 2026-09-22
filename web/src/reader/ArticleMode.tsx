import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import ReaderTurnButton from "./ReaderTurnButton";

type Props = {
  articleId: Id<"articles"> | null;
  watermark: string;
  /** Gedruckte Seitenzahl zu einer Leseseite (U1 statt 1 auf dem Umschlag). */
  pageLabel: (index: number) => string;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  /** Lesesitzung fuer Bilder aus dem Medienspeicher. */
  sessionToken?: string | null;
};

/** Fliesstext. Auf dem Telefon lesbar ohne Zoom, auf dem Schirm ruhig gesetzt. */
export default function ArticleMode({
  articleId,
  watermark,
  pageLabel,
  onPrev,
  onNext,
  canPrev,
  canNext,
  sessionToken,
}: Props) {
  /**
   * Bilder aus dem Medienspeicher kommen ueber das Kachel-Gateway, und das
   * prueft die Lesesitzung. Ein `img`-Element kann keinen eigenen Kopf
   * mitschicken, deshalb steht das Sitzungsmerkmal in der Adresse.
   */
  const mitSitzung = (url: string) =>
    sessionToken && url.includes("/api/asset/")
      ? `${url}${url.includes("?") ? "&" : "?"}s=${encodeURIComponent(sessionToken)}`
      : url;
  const article = useQuery(
    api.articles.getForReader,
    articleId ? { articleId } : "skip",
  );

  if (!articleId) {
    return (
      <div className="article-mode">
        <p className="page-hint">Für diese Ausgabe sind keine Artikel freigegeben.</p>
      </div>
    );
  }
  if (article === undefined) {
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
  const flow = [...new Set([
    ...visibleBlocks.map((item) => item.page),
    ...visibleImages.map((item) => item.page),
  ])]
    .sort((a, b) => a - b)
    .flatMap((page) => {
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
        return [
          ...before,
          ...blocks.flatMap((block) => [block, ...(after.get(block.order) ?? [])]),
          ...images.filter((item) => item.afterBlockOrder === null),
        ];
      }
      const firstTextY = Math.min(...blocks.map((item) => item.y), 1);
      return [
        ...images.filter((item) => item.y < firstTextY),
        ...blocks,
        ...images.filter((item) => item.y >= firstTextY),
      ];
    });

  return (
    <div className="article-mode">
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
      <article className="article-body">
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
                <img src={mitSitzung(img.url ?? "")} alt={img.caption ?? ""} loading="lazy" />
                {img.caption && <figcaption>{img.caption}</figcaption>}
              </figure>
            );
          }
          const b = item.block;
          const key = `block-${item.index}`;
          if (b.type === "heading" || b.type === "subheading") {
            return <h2 key={key} data-source-page={item.page}>{b.text}</h2>;
          }
          if (b.type === "quote") {
            return <blockquote key={key} data-source-page={item.page}>{b.text}</blockquote>;
          }
          if (b.type === "lead") {
            return <p key={key} className="lead" data-source-page={item.page}>{b.text}</p>;
          }
          if (b.type === "caption") {
            return <p key={key} className="caption" data-source-page={item.page}>{b.text}</p>;
          }
          return <p key={key} data-source-page={item.page}>{b.text}</p>;
        })}
      </article>
      {watermark && <div className="watermark">{watermark}</div>}
    </div>
  );
}
