import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import Icon from "../components/Icon";

type Props = {
  issueId: Id<"issues">;
  issueTitle?: string;
  open: boolean;
  onClose: () => void;
  onPage: (pageIndex: number) => void;
  onArticle: (articleId: Id<"articles">) => void;
  mode: "page" | "article";
  /** Artikel, bei dem der Leser gerade steht. */
  currentArticleId: Id<"articles"> | null;
  /** Aufgeschlagene Leseseiten; zwei bei einer Doppelseite. */
  currentPages: number[];
  /** Gedruckte Seitenzahl zu einer Leseseite (U1 statt 1 auf dem Umschlag). */
  pageLabel: (index: number) => string;
};

type Entry = {
  _id: Id<"tocEntries">;
  pageIndex: number | null;
  articleId: Id<"articles"> | null;
};

/**
 * Der Eintrag, bei dem der Leser gerade steht. Zuerst zaehlt der Artikel.
 * Kennt ihn kein Eintrag, gilt wie beim Lesezeichen im Buch die Seite: der
 * Eintrag, der auf der aufgeschlagenen Seite beginnt, sonst der letzte davor.
 */
function currentEntryId(
  entries: Entry[],
  articleId: Id<"articles"> | null,
  pages: number[],
) {
  const byArticle = articleId && entries.find((e) => e.articleId === articleId);
  if (byArticle) return byArticle._id;
  if (pages.length === 0) return null;
  const first = Math.min(...pages);
  const last = Math.max(...pages);
  let before: Entry | null = null;
  for (const e of entries) {
    if (e.pageIndex === null || e.pageIndex > last) continue;
    if (e.pageIndex >= first) return e._id;
    if (!before || e.pageIndex >= (before.pageIndex ?? 0)) before = e;
  }
  return before?._id ?? null;
}

/**
 * Inhaltsverzeichnis als Schublade — aus beiden Modi mit demselben Knopf
 * erreichbar. Kennt ein Eintrag nur eine Seite, springt der Artikelmodus
 * zur Seite; kennt er einen Artikel, oeffnet ihn der Seitenmodus dort.
 */
export default function TocDrawer({
  issueId,
  issueTitle,
  open,
  onClose,
  onPage,
  onArticle,
  mode,
  currentArticleId,
  currentPages,
  pageLabel,
}: Props) {
  const entries = useQuery(api.toc.listForReader, open ? { issueId } : "skip");
  const list = useRef<HTMLUListElement>(null);
  const currentId = entries
    ? currentEntryId(entries, currentArticleId, currentPages)
    : null;

  // Ein Heft hat achtzig Eintraege: der aktuelle steht beim Oeffnen in der
  // Mitte der Liste, sonst laege die Hervorhebung meist unter dem Rand.
  useEffect(() => {
    if (!open || !currentId || !list.current) return;
    const box = list.current;
    const entry = box.querySelector<HTMLButtonElement>(".toc-entry.current");
    if (!entry) return;
    const offset = entry.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += offset - (box.clientHeight - entry.offsetHeight) / 2;
    entry.focus({ preventScroll: true });
  }, [open, currentId]);

  if (!open) return null;

  return (
    <div className="toc-backdrop" onClick={onClose}>
      <aside
        className="toc-drawer"
        aria-label="Inhaltsverzeichnis"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div className="toc-title">
            {issueTitle && <span className="kicker">{issueTitle}</span>}
            <h2>Inhalt</h2>
          </div>
          <button className="btn quiet small" onClick={onClose}>
            <Icon name="close" /> Schließen
          </button>
        </header>
        {entries === undefined && <p className="hint">Laden...</p>}
        {entries?.length === 0 && (
          <p className="hint">Für diese Ausgabe ist kein Inhalt hinterlegt.</p>
        )}
        <ul className="toc-list" ref={list}>
          {entries?.map((e) => {
            const current = e._id === currentId;
            return (
              <li key={e._id} className={`level-${e.level}`}>
                <button
                  className={current ? "toc-entry current" : "toc-entry"}
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    if (mode === "article" && e.articleId) onArticle(e.articleId);
                    else if (e.pageIndex !== null) onPage(e.pageIndex);
                    else if (e.articleId) onArticle(e.articleId);
                    onClose();
                  }}
                >
                  <span className="label">{e.label}</span>
                  {e.pageIndex !== null && (
                    /* Nicht `page`: diese Klasse gehoert dem Seitenrahmen und
                       zog die Seitenzahl auf die volle Breite der Schublade. */
                    <span className="page-num">{pageLabel(e.pageIndex)}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
}
