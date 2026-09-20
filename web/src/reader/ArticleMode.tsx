import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";

type Props = {
  articleId: Id<"articles"> | null;
  watermark: string;
  onPrev: () => void;
  onNext: () => void;
};

/** Fliesstext. Auf dem Telefon lesbar ohne Zoom, auf dem Schirm ruhig gesetzt. */
export default function ArticleMode({ articleId, watermark, onPrev, onNext }: Props) {
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

  return (
    <div className="article-mode">
      <button className="page-edge left" onClick={onPrev} aria-label="Vorheriger Artikel" />
      <button className="page-edge right" onClick={onNext} aria-label="Nächster Artikel" />
      <article className="article-body">
        <h1>{article.title}</h1>
        {article.subtitle && <p className="subtitle">{article.subtitle}</p>}
        {article.author && <p className="byline">{article.author}</p>}
        <p className="meta">
          Seite {article.pageStart + 1}
          {article.pageEnd !== article.pageStart ? `–${article.pageEnd + 1}` : ""}
        </p>
        {article.images.map((img, i) => (
          <figure key={i}>
            <img src={img.url ?? ""} alt={img.caption ?? ""} loading="lazy" />
            {img.caption && <figcaption>{img.caption}</figcaption>}
          </figure>
        ))}
        {article.blocks.map((b, i) => {
          if (b.type === "heading" && i === 0) return null;
          if (b.type === "subheading") return <h2 key={i}>{b.text}</h2>;
          if (b.type === "quote") return <blockquote key={i}>{b.text}</blockquote>;
          if (b.type === "lead") return <p key={i} className="lead">{b.text}</p>;
          if (b.type === "caption") return <p key={i} className="caption">{b.text}</p>;
          return <p key={i}>{b.text}</p>;
        })}
      </article>
      {watermark && <div className="watermark">{watermark}</div>}
    </div>
  );
}
