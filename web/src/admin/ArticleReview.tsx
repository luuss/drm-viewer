import { useEffect, useMemo, useRef, useState } from "react";
import { useFrage } from "../components/Frage";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api, type Id } from "../lib/api";
import ArtikelTabelle from "../components/ArtikelTabelle";
import ArticleProducts from "./ArticleProducts";
import Seitenbild, { useSeiten } from "./Seitenbild";
import {
  BLOCK_TYP,
  MeldungZeile,
  seitenName,
  SpeicherStand,
  useFeldSpeicher,
  useMeldung,
} from "./adminUi";

type Artikel = FunctionReturnType<typeof api.articles.listForEditors>[number];
type Filter = "alle" | "offen" | "unsicher" | "ausgeschlossen";

const STATUS_TEXT = { approved: "freigegeben", pending: "offen", excluded: "ausgeschlossen" };

/**
 * Pruefansicht: links die Artikel, rechts der gewaehlte mit seiner Seite.
 * Artikel werden hier entschieden — freigegeben oder ausgeschlossen. Einen
 * eigenen Veroeffentlichungsschritt je Artikel gibt es nicht; freigegebene
 * Artikel sind sichtbar, sobald die Ausgabe veroeffentlicht ist, und
 * Aenderungen daran wirken sofort.
 *
 * Mit der Tastatur: Pfeil hoch/runter waehlt, F gibt frei, A schliesst aus;
 * danach springt die Auswahl zum naechsten offenen Artikel.
 */
export default function ArticleReview({ issueId }: { issueId: Id<"issues"> }) {
  const frage = useFrage();
  const articles = useQuery(api.articles.listForEditors, { issueId });
  const summary = useQuery(api.articles.reviewSummary, { issueId });
  const productRows = useQuery(api.articleProducts.listForEditors, { issueId });
  const { seiten, labels } = useSeiten(issueId);
  const rematch = useMutation(api.articleProducts.rematch);
  const setReview = useMutation(api.articles.setReviewStatus);
  const approveAll = useMutation(api.articles.approveAllPending);
  const merge = useMutation(api.articles.mergeArticles);

  const [filter, setFilter] = useState<Filter>("alle");
  const [openId, setOpenId] = useState<Id<"articles"> | null>(null);
  const [markiert, setMarkiert] = useState<Set<Id<"articles">>>(new Set());
  const [meldung, tue, busy] = useMeldung();
  const liste = useRef<HTMLUListElement>(null);

  const gezeigt = useMemo(
    () =>
      (articles ?? []).filter((a) => {
        if (filter === "offen") return a.reviewStatus === "pending";
        if (filter === "ausgeschlossen") return a.reviewStatus === "excluded";
        if (filter === "unsicher") return a.confidence !== null && a.confidence < 0.8;
        return true;
      }),
    [articles, filter],
  );
  const open = articles?.find((a) => a._id === openId) ?? null;

  // Ohne Auswahl den ersten offenen Artikel zeigen: dort geht die Arbeit los.
  useEffect(() => {
    if (openId || !articles?.length) return;
    setOpenId((articles.find((a) => a.reviewStatus === "pending") ?? articles[0])._id);
  }, [articles, openId]);

  // Die gewaehlte Zeile bleibt im Blick, auch wenn die Tastatur sie bewegt.
  useEffect(() => {
    liste.current
      ?.querySelector<HTMLElement>(`[data-id="${openId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  function naechsterOffener(nach: Id<"articles">) {
    const pos = gezeigt.findIndex((a) => a._id === nach);
    const rest = [...gezeigt.slice(pos + 1), ...gezeigt.slice(0, pos)];
    return rest.find((a) => a.reviewStatus === "pending")?._id ?? null;
  }

  async function entscheide(a: Artikel, reviewStatus: "approved" | "excluded" | "pending") {
    const weiter = reviewStatus !== "pending" && a.reviewStatus === "pending" ? naechsterOffener(a._id) : null;
    await tue(() => setReview({ articleId: a._id, reviewStatus }));
    if (weiter && a._id === openId) setOpenId(weiter);
  }

  // Tastatur. Nicht in Feldern: dort tippt man Text.
  const zustand = useRef({ gezeigt, open, entscheide });
  zustand.current = { gezeigt, open, entscheide };
  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      const ziel = e.target as HTMLElement | null;
      if (ziel?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { gezeigt, open, entscheide } = zustand.current;
      const pos = open ? gezeigt.findIndex((a) => a._id === open._id) : -1;
      if (e.key === "ArrowDown" || e.key === "j") {
        const n = gezeigt[Math.min(gezeigt.length - 1, pos + 1)];
        if (n) setOpenId(n._id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        const n = gezeigt[Math.max(0, pos - 1)];
        if (n) setOpenId(n._id);
      } else if ((e.key === "f" || e.key === "F") && open) {
        void entscheide(open, "approved");
      } else if ((e.key === "a" || e.key === "A") && open) {
        void entscheide(open, "excluded");
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", taste);
    return () => window.removeEventListener("keydown", taste);
  }, []);

  if (articles === undefined) return <p className="hint">Laden...</p>;
  if (articles.length === 0)
    return (
      <div className="empty">
        <p>Noch keine Artikel. Sie entstehen bei der Aufbereitung.</p>
      </div>
    );

  const pendingCount =
    summary?.pending ?? articles.filter((a) => a.reviewStatus === "pending").length;
  const unsicher = articles.filter((a) => a.confidence !== null && a.confidence < 0.8).length;
  const productsOf = (articleId: Id<"articles">) =>
    (productRows ?? []).filter((r) => r.articleId === articleId);
  const ohneZuordnung = (productRows ?? []).filter((r) => !r.product && r.source !== "editor").length;
  const seiteVon = (a: Artikel) =>
    seitenName(labels, a.pageStart) +
    (a.pageEnd !== a.pageStart ? `–${seitenName(labels, a.pageEnd)}` : "");

  const auswahl = articles.filter((a) => markiert.has(a._id)).sort((x, y) => x.order - y.order);

  return (
    <div className="review">
      <div className="review-leiste">
        <div className="segment" role="group" aria-label="Filter">
          {(
            [
              ["alle", `Alle ${articles.length}`],
              ["offen", `Offen ${pendingCount}`],
              ["unsicher", `Unsicher ${unsicher}`],
              ["ausgeschlossen", `Ausgeschlossen ${summary?.excluded ?? 0}`],
            ] as [Filter, string][]
          ).map(([wert, text]) => (
            <button key={wert} type="button" aria-pressed={filter === wert} onClick={() => setFilter(wert)}>
              {text}
            </button>
          ))}
        </div>
        {pendingCount > 0 && (
          <button
            className="btn"
            disabled={busy !== null}
            aria-busy={busy === "alle"}
            onClick={async () => {
              const weiter = await frage({
                titel: `${pendingCount} offene Artikel freigeben?`,
                text: "Bei einer veröffentlichten Ausgabe sind sie sofort sichtbar.",
                ja: "Freigeben",
              });
              if (!weiter) return;
              await tue(
                () => approveAll({ issueId }),
                (r) =>
                  `${r.approved} Artikel freigegeben` +
                  (r.remaining ? " — es sind noch weitere offen, bitte noch einmal." : ""),
                "alle",
              );
            }}
          >
            Alle offenen freigeben
          </button>
        )}
      </div>
      <p className="hint small tasten">
        Tasten: ↑ ↓ wählen · F freigeben · A ausschließen
        {ohneZuordnung > 0 && (
          <>
            {" · "}
            {ohneZuordnung} Buchanzeigen ohne Produkt{" "}
            <button
              className="btn quiet small"
              disabled={busy !== null}
              onClick={() => tue(() => rematch({ issueId }), "Abgleich läuft, die Liste füllt sich von selbst")}
            >
              Mit dem Netzladen abgleichen
            </button>
          </>
        )}
      </p>
      <MeldungZeile meldung={meldung} />

      {auswahl.length > 1 && (
        <div className="auswahl-leiste">
          <span>{auswahl.length} Artikel ausgewählt</span>
          <button
            className="btn small"
            disabled={busy !== null}
            onClick={async () => {
              const [ziel, ...rest] = auswahl;
              const weiter = await frage({
                titel: `${auswahl.length} Artikel zusammenführen?`,
                text: `Alles kommt in „${ziel.title || "(ohne Titel)"}“, in der Reihenfolge des Hefts.`,
                ja: "Zusammenführen",
              });
              if (!weiter) return;
              await tue(async () => {
                for (const a of rest) await merge({ targetId: ziel._id, sourceId: a._id });
              }, "Zusammengeführt");
              setMarkiert(new Set());
              setOpenId(ziel._id);
            }}
          >
            Zusammenführen
          </button>
          <button className="btn quiet small" onClick={() => setMarkiert(new Set())}>
            Auswahl aufheben
          </button>
        </div>
      )}

      <div className="pruef-split">
        <ul className="article-rows" ref={liste}>
          {gezeigt.map((a) => (
            <li key={a._id} data-id={a._id} className={`${a.reviewStatus}${openId === a._id ? " gewaehlt" : ""}`}>
              <input
                type="checkbox"
                aria-label={`${a.title || "Artikel"} auswählen`}
                checked={markiert.has(a._id)}
                onChange={(e) => {
                  const neu = new Set(markiert);
                  if (e.target.checked) neu.add(a._id);
                  else neu.delete(a._id);
                  setMarkiert(neu);
                }}
              />
              <button
                className={openId === a._id ? "row-title open" : "row-title"}
                onClick={() => setOpenId(a._id)}
              >
                <span className="title">{a.title || "(ohne Titel)"}</span>
                <span className="meta">
                  S. {seiteVon(a)}
                  {a.confidence !== null && a.confidence < 0.8 ? " · unsicher" : ""}
                  {productsOf(a._id).some((r) => r.product) ? " · Bestellknopf" : ""}
                  {productsOf(a._id).some((r) => !r.product && r.source !== "editor")
                    ? " · Anzeige ohne Produkt"
                    : ""}
                </span>
              </button>
              <span className={`badge ${a.reviewStatus}`}>{STATUS_TEXT[a.reviewStatus]}</span>
            </li>
          ))}
          {gezeigt.length === 0 && <li className="hint">Kein Artikel in dieser Auswahl.</li>}
        </ul>

        {open ? (
          <ArtikelBearbeiten
            key={open._id}
            artikel={open}
            seiten={seiten}
            labels={labels}
            produkte={productsOf(open._id)}
            entscheide={(s) => entscheide(open, s)}
            beschaeftigt={busy !== null}
            weg={() => setOpenId(null)}
          />
        ) : (
          <div className="empty">
            <p>Einen Artikel links wählen.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ArtikelBearbeiten({
  artikel: a,
  seiten,
  labels,
  produkte,
  entscheide,
  beschaeftigt,
  weg,
}: {
  artikel: Artikel;
  seiten: ReturnType<typeof useSeiten>["seiten"];
  labels: ReturnType<typeof useSeiten>["labels"];
  produkte: Parameters<typeof ArticleProducts>[0]["rows"];
  entscheide: (s: "approved" | "excluded" | "pending") => Promise<void>;
  beschaeftigt: boolean;
  weg: () => void;
}) {
  const frage = useFrage();
  const update = useMutation(api.articles.updateArticle);
  const removeArticle = useMutation(api.articles.removeArticle);
  const [stand, speichere] = useFeldSpeicher();
  const [meldung, tue] = useMeldung();

  // Die Seiten, auf denen der Artikel Flaechen hat; ohne Flaechen die erste.
  const seitenDesArtikels = useMemo(() => {
    const s = [...new Set(a.regions.map((r) => r.pageIndex))].sort((x, y) => x - y);
    return s.length ? s : [a.primaryPageIndex ?? a.pageStart];
  }, [a]);
  const [seite, setSeite] = useState(seitenDesArtikels[0]);

  const feld = (name: "title" | "subtitle" | "author" | "teaser", wert: string | null) => ({
    defaultValue: wert ?? "",
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.target.value === (wert ?? "")) return;
      void speichere(() => update({ articleId: a._id, [name]: e.target.value }));
    },
  });

  return (
    <div className="article-editor">
      <div className="editor-kopf">
        <span className="hint">Artikel {a.order}</span>
        <span className={`badge ${a.reviewStatus}`}>{STATUS_TEXT[a.reviewStatus]}</span>
        <SpeicherStand stand={stand} />
        <span className="editor-entscheidung">
          {a.reviewStatus !== "excluded" ? (
            <button className="btn secondary small" disabled={beschaeftigt} onClick={() => entscheide("excluded")}>
              Ausschließen
            </button>
          ) : (
            <button className="btn secondary small" disabled={beschaeftigt} onClick={() => entscheide("pending")}>
              Wieder öffnen
            </button>
          )}
          {a.reviewStatus !== "approved" && (
            <button className="btn small" disabled={beschaeftigt} onClick={() => entscheide("approved")}>
              Freigeben
            </button>
          )}
        </span>
      </div>

      <div className="editor-seite">
        {seitenDesArtikels.length > 1 && (
          <div className="segment klein" role="group" aria-label="Seite">
            {seitenDesArtikels.map((s) => (
              <button key={s} type="button" aria-pressed={seite === s} onClick={() => setSeite(s)}>
                S. {seitenName(labels, s)}
              </button>
            ))}
          </div>
        )}
        <Seitenbild
          seite={seiten?.find((s) => s.index === seite)}
          flaechen={a.regions
            .filter((r) => r.pageIndex === seite)
            .map((r) => ({ ...r, key: r._id, klasse: r.kind }))}
        />
      </div>

      <label>
        Titel
        <input {...feld("title", a.title)} />
      </label>
      <label>
        Unterzeile
        <input {...feld("subtitle", a.subtitle)} />
      </label>
      <label>
        Autor
        <input {...feld("author", a.author)} />
      </label>

      <ArticleProducts articleId={a._id} rows={produkte} />

      <h4 className="bloecke-titel">Text</h4>
      <ol className="blocks">
        {a.blocks.map((b) => (
          <Block key={b._id} block={b} artikelId={a._id} onGetrennt={weg} speichere={speichere} />
        ))}
      </ol>

      <MeldungZeile meldung={meldung} />
      <button
        className="btn quiet small danger"
        onClick={async () => {
          const weiter = await frage({
            titel: "Artikel löschen?",
            text: `„${a.title}“ wird entfernt. Rückgängig geht das nur über eine neue Aufbereitung.`,
            ja: "Löschen",
            gefahr: true,
          });
          if (weiter) await tue(() => removeArticle({ articleId: a._id }).then(weg));
        }}
      >
        Artikel löschen
      </button>
    </div>
  );
}

function Block({
  block: b,
  artikelId,
  onGetrennt,
  speichere,
}: {
  block: Artikel["blocks"][number];
  artikelId: Id<"articles">;
  onGetrennt: () => void;
  speichere: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const updateBlock = useMutation(api.articles.updateBlock);
  const deleteBlock = useMutation(api.articles.deleteBlock);
  const moveBlock = useMutation(api.articles.moveBlock);
  const split = useMutation(api.articles.splitAtBlock);

  return (
    <li>
      <span className="block-kopf">
        {b.type === "table" ? (
          <span className="badge">Tabelle</span>
        ) : (
          <select
            className="block-typ"
            value={b.type}
            aria-label="Art des Absatzes"
            onChange={(e) =>
              speichere(() => updateBlock({ blockId: b._id, type: e.target.value as typeof b.type }))
            }
          >
            {Object.entries(BLOCK_TYP)
              .filter(([k]) => k !== "table")
              .map(([k, text]) => (
                <option key={k} value={k}>
                  {text}
                </option>
              ))}
          </select>
        )}
        <span className="block-actions">
          <button
            className="btn quiet small"
            title="Nach oben"
            aria-label="Nach oben"
            onClick={() => speichere(() => moveBlock({ blockId: b._id, direction: "up" }))}
          >
            ↑
          </button>
          <button
            className="btn quiet small"
            title="Nach unten"
            aria-label="Nach unten"
            onClick={() => speichere(() => moveBlock({ blockId: b._id, direction: "down" }))}
          >
            ↓
          </button>
          <button
            className="btn quiet small"
            onClick={() =>
              speichere(async () => {
                await split({ articleId: artikelId, firstBlockOfSecond: b._id });
                onGetrennt();
              })
            }
          >
            Ab hier trennen
          </button>
          <button
            className="btn quiet small danger"
            onClick={() => speichere(() => deleteBlock({ blockId: b._id }))}
          >
            Löschen
          </button>
        </span>
      </span>
      {b.type === "table" && b.table ? (
        // Eine Tabelle wird so gezeigt, wie der Leser sie sieht. Als Text
        // bearbeiten laesst sie sich nicht; verschieben, trennen und
        // loeschen schon.
        <div className="review-table">
          <ArtikelTabelle table={b.table} />
        </div>
      ) : (
        <textarea
          defaultValue={b.text}
          rows={Math.min(8, Math.ceil(b.text.length / 90) + 1)}
          onBlur={(e) => {
            if (e.target.value === b.text) return;
            void speichere(() => updateBlock({ blockId: b._id, text: e.target.value }));
          }}
        />
      )}
    </li>
  );
}
