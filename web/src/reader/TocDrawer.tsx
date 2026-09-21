import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";

type Props = {
  issueId: Id<"issues">;
  open: boolean;
  onClose: () => void;
  onPage: (pageIndex: number) => void;
  onArticle: (articleId: Id<"articles">) => void;
  mode: "page" | "article";
  /** Gedruckte Seitenzahl zu einer Leseseite (U1 statt 1 auf dem Umschlag). */
  pageLabel: (index: number) => string;
};

/**
 * Inhaltsverzeichnis als Schublade — aus beiden Modi mit demselben Knopf
 * erreichbar. Kennt ein Eintrag nur eine Seite, springt der Artikelmodus
 * zur Seite; kennt er einen Artikel, oeffnet ihn der Seitenmodus dort.
 */
export default function TocDrawer({
  issueId,
  open,
  onClose,
  onPage,
  onArticle,
  mode,
  pageLabel,
}: Props) {
  const entries = useQuery(api.toc.listForReader, open ? { issueId } : "skip");
  if (!open) return null;

  return (
    <div className="toc-backdrop" onClick={onClose}>
      <aside className="toc-drawer" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Inhalt</h3>
          <button className="link-btn" onClick={onClose}>
            Schliessen
          </button>
        </header>
        {entries === undefined && <p className="hint">Laden...</p>}
        {entries?.length === 0 && (
          <p className="hint">Für diese Ausgabe ist kein Inhalt hinterlegt.</p>
        )}
        <ul>
          {entries?.map((e) => (
            <li key={e._id} className={`level-${e.level}`}>
              <button
                className="toc-entry"
                onClick={() => {
                  if (mode === "article" && e.articleId) onArticle(e.articleId);
                  else if (e.pageIndex !== null) onPage(e.pageIndex);
                  else if (e.articleId) onArticle(e.articleId);
                  onClose();
                }}
              >
                <span className="label">{e.label}</span>
                {e.pageIndex !== null && (
                  <span className="page">{pageLabel(e.pageIndex)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
