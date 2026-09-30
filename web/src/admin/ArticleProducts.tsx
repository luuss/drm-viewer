import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api, type Id, cleanError, formatEuro } from "../lib/api";

export type ProductRow = FunctionReturnType<typeof api.articleProducts.listForEditors>[number];
type Found = FunctionReturnType<typeof api.articleProducts.searchShop>[number];

const SOURCE_LABEL: Record<ProductRow["source"], string> = {
  number: "Artikelnummer",
  title: "Titelabgleich",
  editor: "Redaktion",
};

/**
 * Produkte im Netzladen zu einem Artikel. Die Zuordnung kommt vom Abgleich
 * nach dem Import; hier laesst sie sich korrigieren: eine falsche entfernen,
 * einer offenen Anzeige ein Produkt geben, ein weiteres ergaenzen. Eine
 * Entscheidung der Redaktion bleibt auch nach einem neuen Import bestehen.
 */
export default function ArticleProducts({
  articleId,
  rows,
}: {
  articleId: Id<"articles">;
  rows: ProductRow[];
}) {
  const searchShop = useAction(api.articleProducts.searchShop);
  const addProduct = useAction(api.articleProducts.addProduct);
  const removeLink = useMutation(api.articleProducts.removeLink);
  const resetBlock = useMutation(api.articleProducts.resetBlock);

  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  // Offene Anzeige, fuer die gerade ein Produkt gesucht wird.
  const [target, setTarget] = useState<Id<"articleBlocks"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  const linked = new Set(rows.flatMap((r) => (r.product ? [r.product.productId] : [])));
  const decided = new Set(rows.filter((r) => r.source === "editor").map((r) => r.blockId));

  return (
    <div className="article-products">
      <h5>Produkte im Netzladen</h5>
      {rows.length === 0 && (
        <p className="hint">Keine Buchanzeige erkannt. Ein Produkt lässt sich von Hand ergänzen.</p>
      )}
      <ul>
        {rows.map((row) => (
          <li key={row._id}>
            {row.product ? (
              <span className="what">
                <a href={row.product.url} target="_blank" rel="noopener noreferrer">
                  {row.product.name}
                </a>
                <span className="hint">
                  {[
                    row.product.reference && `Art. ${row.product.reference}`,
                    row.product.priceCents !== null && formatEuro(row.product.priceCents),
                    SOURCE_LABEL[row.source],
                    !row.product.active && "im Netzladen nicht aktiv, im Leser: Knopf „Zum Shop“",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            ) : (
              <span className="what">
                <span>{row.note ?? "Ohne Produkt"}</span>
                <span className="hint">
                  {row.label ? `„${row.label}“ · ` : ""}
                  {row.source === "editor" ? "im Leser ohne Knopf" : "im Leser: Knopf „Zum Shop“ (Startseite)"}
                </span>
              </span>
            )}
            <span className="row-actions">
              {row.product ? (
                <button
                  className="btn quiet small danger"
                  disabled={busy}
                  onClick={() => run(() => removeLink({ linkId: row._id }))}
                >
                  Entfernen
                </button>
              ) : (
                <>
                  <button
                    className="btn quiet small"
                    disabled={busy}
                    onClick={() => setTarget(row.blockId)}
                  >
                    Produkt wählen
                  </button>
                  {row.source !== "editor" && (
                    <button
                      className="btn quiet small danger"
                      disabled={busy}
                      onClick={() => run(() => removeLink({ linkId: row._id }))}
                    >
                      Kein Knopf
                    </button>
                  )}
                </>
              )}
              {row.source === "editor" && (
                <button
                  className="btn quiet small"
                  disabled={busy}
                  onClick={() => run(() => resetBlock({ blockId: row.blockId }))}
                >
                  Automatik
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setFound(await searchShop({ q: query })));
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Titel, Artikelnummer oder Produktadresse"
          aria-label={target ? "Produkt für die offene Anzeige suchen" : "Produkt im Netzladen suchen"}
        />
        <button className="btn secondary small" disabled={busy || !query.trim()}>
          Suchen
        </button>
      </form>
      {target && (
        <p className="hint">
          Das gewählte Produkt ersetzt die offene Anzeige.{" "}
          <button className="btn quiet small" onClick={() => setTarget(null)}>
            Abbrechen
          </button>
        </p>
      )}
      {err && <div className="err">{err}</div>}
      {found && found.length === 0 && <p className="hint">Keine Treffer im Netzladen.</p>}
      {found && found.length > 0 && (
        <ul>
          {found.map((p) => (
            <li key={p.productId}>
              <span className="what">
                <a href={p.url} target="_blank" rel="noopener noreferrer">
                  {p.name}
                </a>
                <span className="hint">
                  {[
                    p.manufacturer,
                    p.reference && `Art. ${p.reference}`,
                    p.priceCents !== null && formatEuro(p.priceCents),
                    !p.active && "nicht aktiv",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="row-actions">
                <button
                  className="btn secondary small"
                  disabled={busy || (linked.has(p.productId) && !target)}
                  onClick={() =>
                    run(async () => {
                      // Eine offene Anzeige oder ein schon entschiedener Absatz
                      // nimmt das Produkt auf; sonst waehlt der Server den Absatz.
                      const blockId = target ?? [...decided][0] ?? undefined;
                      await addProduct({ articleId, blockId, productId: p.productId });
                      setTarget(null);
                      setFound(null);
                      setQuery("");
                    })
                  }
                >
                  {linked.has(p.productId) && !target ? "Verknüpft" : "Übernehmen"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
