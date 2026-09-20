import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../../lib/convex";

/**
 * Redaktionsansicht je Ausgabe. Die Extraktion liefert Entwuerfe; hier werden
 * falsch getrennte Artikel zusammengefuehrt, falsch zusammengezogene geteilt
 * und am Ende freigegeben.
 */
export default function AdminArticles({ bookId }: { bookId: Id<"books"> }) {
  const articles = useQuery(api.articles.listForAdmin, { bookId });
  const update = useMutation(api.articles.updateArticle);
  const remove = useMutation(api.articles.deleteArticle);
  const merge = useMutation(api.articles.mergeArticles);
  const split = useMutation(api.articles.splitArticle);
  const publishAll = useMutation(api.articles.publishAll);

  const [openId, setOpenId] = useState<Id<"articles"> | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftText, setDraftText] = useState("");
  const [mergeSource, setMergeSource] = useState<Id<"articles"> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (articles === undefined) return <p>Laden...</p>;
  if (articles.length === 0)
    return <p className="hint">Noch keine Artikel. Erst Import starten.</p>;

  const open = articles.find((a) => a._id === openId) ?? null;

  return (
    <div className="admin-articles">
      <div className="row">
        <strong>{articles.length} Artikel</strong>
        <span className="hint">
          {articles.filter((a) => a.status === "published").length} freigegeben
        </span>
        <button className="btn" onClick={() => publishAll({ bookId })}>
          Alle freigeben
        </button>
      </div>
      {err && <div className="err">{err}</div>}

      <ul className="article-rows">
        {articles.map((a) => (
          <li key={a._id} className={a.status === "draft" ? "draft" : ""}>
            <span className="grow">
              <strong>{a.order}.</strong> {a.title || "(ohne Titel)"}{" "}
              <span className="hint">
                S. {a.pageStart}
                {a.pageEnd !== a.pageStart ? `–${a.pageEnd}` : ""} ·{" "}
                {a.text.length} Zeichen · {a.status}
              </span>
            </span>
            <button
              className="link-btn"
              onClick={() => {
                setOpenId(a._id);
                setDraftTitle(a.title);
                setDraftText(a.text);
              }}
            >
              bearbeiten
            </button>
            <button
              className="link-btn"
              onClick={() =>
                update({
                  articleId: a._id,
                  status: a.status === "published" ? "draft" : "published",
                })
              }
            >
              {a.status === "published" ? "zurückziehen" : "freigeben"}
            </button>
            {mergeSource === null ? (
              <button className="link-btn" onClick={() => setMergeSource(a._id)}>
                zusammenführen ab hier
              </button>
            ) : mergeSource === a._id ? (
              <button className="link-btn" onClick={() => setMergeSource(null)}>
                abbrechen
              </button>
            ) : (
              <button
                className="link-btn"
                onClick={async () => {
                  setErr(null);
                  try {
                    await merge({ targetId: a._id, sourceId: mergeSource });
                    setMergeSource(null);
                  } catch (e: any) {
                    setErr(e?.message ?? "Fehler");
                  }
                }}
              >
                hierher zusammenführen
              </button>
            )}
            <button
              className="link-btn danger"
              onClick={() => {
                if (confirm(`"${a.title}" löschen?`)) remove({ articleId: a._id });
              }}
            >
              löschen
            </button>
          </li>
        ))}
      </ul>

      {open && (
        <div className="article-editor">
          <h4>Artikel bearbeiten</h4>
          <label>
            Titel
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
            />
          </label>
          <label>
            Text
            <textarea
              rows={16}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                await update({
                  articleId: open._id,
                  title: draftTitle,
                  text: draftText,
                });
                setOpenId(null);
              }}
            >
              Speichern
            </button>
            <button
              className="btn secondary"
              onClick={async () => {
                const el = document.querySelector<HTMLTextAreaElement>(
                  ".article-editor textarea",
                );
                const pos = el?.selectionStart ?? 0;
                if (pos <= 0) {
                  setErr("Cursor an die Trennstelle im Text setzen.");
                  return;
                }
                const title = prompt("Titel des zweiten Artikels?") ?? "Ohne Titel";
                await update({ articleId: open._id, text: draftText });
                await split({ articleId: open._id, splitAt: pos, newTitle: title });
                setOpenId(null);
              }}
            >
              An Cursor teilen
            </button>
            <button className="link-btn" onClick={() => setOpenId(null)}>
              Schliessen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
