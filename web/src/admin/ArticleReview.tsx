import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, type Id , cleanError } from "../lib/api";

/**
 * Pruefansicht: links die Seitenlage der Regionen, rechts die Bloecke.
 * Artikel werden hier entschieden — freigegeben oder ausgeschlossen. Einen
 * eigenen Veroeffentlichungsschritt je Artikel gibt es nicht; freigegebene
 * Artikel sind sichtbar, sobald die Ausgabe veroeffentlicht ist, und
 * Aenderungen daran wirken sofort.
 */
export default function ArticleReview({ issueId }: { issueId: Id<"issues"> }) {
  const articles = useQuery(api.articles.listForEditors, { issueId });
  const summary = useQuery(api.articles.reviewSummary, { issueId });
  const update = useMutation(api.articles.updateArticle);
  const updateBlock = useMutation(api.articles.updateBlock);
  const deleteBlock = useMutation(api.articles.deleteBlock);
  const moveBlock = useMutation(api.articles.moveBlock);
  const merge = useMutation(api.articles.mergeArticles);
  const split = useMutation(api.articles.splitAtBlock);
  const setReview = useMutation(api.articles.setReviewStatus);
  const approveAll = useMutation(api.articles.approveAllPending);
  const removeArticle = useMutation(api.articles.removeArticle);

  const [openId, setOpenId] = useState<Id<"articles"> | null>(null);
  const [mergeSource, setMergeSource] = useState<Id<"articles"> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (articles === undefined) return <p className="hint">Laden...</p>;
  if (articles.length === 0)
    return <p className="hint">Noch keine Artikel. Erst den Import starten.</p>;

  const open = articles.find((a) => a._id === openId) ?? null;

  async function guard(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(cleanError(e) ?? "Fehler");
    }
  }

  return (
    <div className="review">
      <div className="review-summary">
        <span className="count">{summary?.total ?? articles.length} Artikel</span>
        <span className="hint">
          {summary?.approved ?? 0} freigegeben · {summary?.pending ?? 0} offen ·{" "}
          {summary?.excluded ?? 0} ausgeschlossen
        </span>
        <button className="btn" onClick={() => guard(() => approveAll({ issueId }))}>
          Alle offenen freigeben
        </button>
      </div>
      {err && <div className="err">{err}</div>}

      {/* Solange kein Artikel offen ist, braucht die rechte Haelfte keinen Platz;
          die Liste stand sonst in einer halb so breiten Spalte und brach um. */}
      <div className={open ? "review-split" : "review-split single"}>
        <ul className="article-rows">
          {articles.map((a) => (
            <li key={a._id} className={a.reviewStatus}>
              <span className="num">{a.order}.</span>
              <button
                className={openId === a._id ? "row-title open" : "row-title"}
                onClick={() => setOpenId(a._id)}
              >
                <span className="title">{a.title || "(ohne Titel)"}</span>
                <span className="meta">
                  S. {a.pageStart + 1}
                  {a.pageEnd !== a.pageStart ? `–${a.pageEnd + 1}` : ""} ·{" "}
                  {a.charCount} Zeichen · {a.blocks.length} Blöcke
                  {a.confidence !== null && a.confidence < 0.8
                    ? ` · unsicher (${a.confidence})`
                    : ""}
                </span>
              </button>
              <span className={`badge ${a.reviewStatus}`}>
                {a.reviewStatus === "approved"
                  ? "freigegeben"
                  : a.reviewStatus === "excluded"
                    ? "ausgeschlossen"
                    : "offen"}
              </span>
              <span className="row-actions">
                <button
                  className="btn quiet small"
                  onClick={() =>
                    guard(() => setReview({ articleId: a._id, reviewStatus: "approved" }))
                  }
                >
                  Freigeben
                </button>
                <button
                  className="btn quiet small"
                  onClick={() =>
                    guard(() => setReview({ articleId: a._id, reviewStatus: "excluded" }))
                  }
                >
                  Ausschliessen
                </button>
                {mergeSource === null ? (
                  <button className="btn quiet small" onClick={() => setMergeSource(a._id)}>
                    Ab hier zusammenführen
                  </button>
                ) : mergeSource === a._id ? (
                  <button className="btn quiet small" onClick={() => setMergeSource(null)}>
                    Abbrechen
                  </button>
                ) : (
                  <button
                    className="btn quiet small"
                    onClick={() =>
                      guard(async () => {
                        await merge({ targetId: a._id, sourceId: mergeSource! });
                        setMergeSource(null);
                      })
                    }
                  >
                    Hierher zusammenführen
                  </button>
                )}
                <button
                  className="btn quiet small danger"
                  onClick={() => {
                    if (confirm(`"${a.title}" löschen?`)) {
                      guard(() => removeArticle({ articleId: a._id }));
                    }
                  }}
                >
                  Löschen
                </button>
              </span>
            </li>
          ))}
        </ul>

        {open && (
          <div className="article-editor">
            <h4>Artikel bearbeiten</h4>
            <label>
              Titel
              <input
                defaultValue={open.title}
                onBlur={(e) =>
                  guard(() => update({ articleId: open._id, title: e.target.value }))
                }
              />
            </label>
            <label>
              Unterzeile
              <input
                defaultValue={open.subtitle ?? ""}
                onBlur={(e) =>
                  guard(() => update({ articleId: open._id, subtitle: e.target.value }))
                }
              />
            </label>
            <label>
              Autor
              <input
                defaultValue={open.author ?? ""}
                onBlur={(e) =>
                  guard(() => update({ articleId: open._id, author: e.target.value }))
                }
              />
            </label>
            <p className="hint">
              Regionen: {open.regions.length} Klickflächen auf Seite{" "}
              {open.regions.map((r) => r.pageIndex + 1).join(", ") || "—"}
            </p>

            <ol className="blocks">
              {open.blocks.map((b) => (
                <li key={b._id}>
                  <span className="badge">{b.type}</span>
                  <textarea
                    defaultValue={b.text}
                    rows={Math.min(6, Math.ceil(b.text.length / 90) + 1)}
                    onBlur={(e) =>
                      guard(() => updateBlock({ blockId: b._id, text: e.target.value }))
                    }
                  />
                  <span className="block-actions">
                    <button
                      className="btn quiet small"
                      onClick={() => guard(() => moveBlock({ blockId: b._id, direction: "up" }))}
                    >
                      Hoch
                    </button>
                    <button
                      className="btn quiet small"
                      onClick={() => guard(() => moveBlock({ blockId: b._id, direction: "down" }))}
                    >
                      Runter
                    </button>
                    <button
                      className="btn quiet small"
                      onClick={() =>
                        guard(async () => {
                          await split({
                            articleId: open._id,
                            firstBlockOfSecond: b._id,
                          });
                          setOpenId(null);
                        })
                      }
                    >
                      Ab hier trennen
                    </button>
                    <button
                      className="btn quiet small danger"
                      onClick={() => guard(() => deleteBlock({ blockId: b._id }))}
                    >
                      Löschen
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <button className="btn secondary" onClick={() => setOpenId(null)}>
              Schliessen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
