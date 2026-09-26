import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api, cleanError, formatEuro, formatDate, type Id } from "../lib/api";
import { useFrage } from "../components/Frage";

type Product = {
  id: number;
  name: string;
  reference: string;
  priceCents: number | null;
  url: string;
  coverUrl: string | null;
  manufacturer: string;
  active: boolean;
  digital: null | {
    idProductAttribute: number;
    sku: string;
    priceCents: number | null;
    available: boolean;
  };
};

type Digital = {
  offered: boolean;
  idProductAttribute?: number;
  sku?: string;
  priceCents?: number;
  url?: string;
  syncedAt: number;
};

/**
 * Karte "Druckheft im Shop": das Heft dem Druckheft im Laden zuordnen und dort
 * die E-Paper-Variante anbieten. Beim Oeffnen sucht der Leser selbst mit Reihe
 * und Heftnummer; der beste Treffer ist vorausgewaehlt. Solange das Ladenmodul
 * nicht erreichbar ist, steht hier nur dessen Fehlermeldung.
 *
 * Veroeffentlichen im Leser und Anbieten im Shop sind getrennte Schritte.
 */
export default function ShopDruckheft({
  issue,
}: {
  issue: {
    _id: Id<"issues">;
    isPublished: boolean;
    shopProductId: number | null;
    shopUrl: string | null;
    externalSku: string | null;
    shopDigital: Digital | null;
  };
}) {
  const frage = useFrage();
  const search = useAction(api.shopCatalog.search);
  const select = useAction(api.shopCatalog.select);
  const offer = useAction(api.shopCatalog.offer);
  const withdraw = useAction(api.shopCatalog.withdraw);
  const refresh = useAction(api.shopCatalog.refresh);

  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setErr(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setErr(cleanError(e));
    } finally {
      setBusy(null);
    }
  }

  async function find(q?: string) {
    await run("search", async () => {
      const res = await search({ issueId: issue._id, q });
      setQuery(res.query);
      setProducts(res.products);
      const current = res.products.find((p) => p.id === issue.shopProductId);
      setChosen(current?.id ?? res.products[0]?.id ?? null);
    });
  }

  // Vorschlag beim Oeffnen, einmal je Heft.
  useEffect(() => {
    void find();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue._id]);

  const digital = issue.shopDigital;
  const offered = digital?.offered ?? false;
  const chosenProduct = products?.find((p) => p.id === chosen) ?? null;

  return (
    <div className="shop-card">
      <h4>Druckheft im Shop</h4>

      {issue.shopProductId ? (
        <p className="small">
          Zugeordnet: Produkt {issue.shopProductId}
          {issue.shopUrl && (
            <>
              {" · "}
              <a href={issue.shopUrl} target="_blank" rel="noopener noreferrer">
                im Shop ansehen
              </a>
            </>
          )}
          {issue.externalSku && <> · Artikelnummer {issue.externalSku}</>}
        </p>
      ) : (
        <p className="small muted">Noch keinem Druckheft zugeordnet.</p>
      )}

      {issue.shopProductId && (
        <p className="small">
          E-Paper im Shop:{" "}
          <span className={`badge ${offered ? "live" : "pending"}`}>
            {offered ? "angeboten" : "nicht angeboten"}
          </span>
          {offered && digital?.priceCents !== undefined && <> · {formatEuro(digital.priceCents)}</>}
          {offered && digital?.url && (
            <>
              {" · "}
              <a href={digital.url} target="_blank" rel="noopener noreferrer">
                Link
              </a>
            </>
          )}
          {digital && <span className="muted"> · Stand {formatDate(digital.syncedAt)}</span>}
        </p>
      )}
      {issue.isPublished && !offered && (
        <p className="err small">
          Im Leser veröffentlicht, im Shop aber nicht als E-Paper angeboten.
        </p>
      )}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void find(query);
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Im Shop suchen"
          aria-label="Im Shop suchen"
        />
        <button className="btn secondary small" disabled={busy !== null}>
          {busy === "search" ? "Sucht…" : "Suchen"}
        </button>
      </form>

      {products && products.length === 0 && (
        <p className="small muted">Keine Treffer. Anderen Suchbegriff versuchen.</p>
      )}
      {products && products.length > 0 && (
        <fieldset className="shop-results">
          <legend className="small">Treffer, bester Vorschlag zuerst</legend>
          {products.map((p) => (
            <label key={p.id} className={p.id === chosen ? "selected" : undefined}>
              <input
                type="radio"
                name={`shop-${issue._id}`}
                checked={p.id === chosen}
                onChange={() => setChosen(p.id)}
              />
              {p.coverUrl ? <img src={p.coverUrl} alt="" loading="lazy" /> : <span className="thumb" />}
              <span className="what">
                <strong>{p.name}</strong>
                <span className="muted">
                  {[
                    p.reference && `Ref. ${p.reference}`,
                    p.priceCents !== null && formatEuro(p.priceCents),
                    !p.active && "inaktiv",
                    p.digital && (p.digital.available ? "E-Paper angeboten" : "E-Paper angelegt"),
                    p.id === issue.shopProductId && "zugeordnet",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="row actions">
        <button
          className="btn small"
          disabled={busy !== null || !chosenProduct}
          onClick={() =>
            chosenProduct &&
            run("select", async () => {
              const res = await select({ issueId: issue._id, productId: chosenProduct.id });
              setMsg(res.messages.join(" · "));
            })
          }
        >
          {busy === "select" ? "Übernimmt…" : "Übernehmen"}
        </button>
        <button
          className="btn secondary small"
          disabled={busy !== null || !issue.shopProductId}
          onClick={() =>
            run("offer", async () => {
              const s = await offer({ issueId: issue._id });
              setMsg(
                `Im Shop angeboten${s.priceCents !== undefined ? ` für ${formatEuro(s.priceCents)}` : ""}`,
              );
            })
          }
        >
          {busy === "offer" ? "Wird angeboten…" : "Im Shop als E-Paper anbieten"}
        </button>
        {offered && (
          <button
            className="btn secondary small danger"
            disabled={busy !== null}
            onClick={async () => {
              const weiter = await frage({
                titel: "E-Paper aus dem Shop nehmen?",
                text: "Die Variante ist danach im Shop nicht mehr kaufbar. Wer schon gekauft hat, behält den Zugriff.",
                ja: "Aus dem Shop nehmen",
                gefahr: true,
              });
              if (!weiter) return;
              await run("withdraw", async () => {
                await withdraw({ issueId: issue._id });
                setMsg("Aus dem Shop genommen");
              });
            }}
          >
            Aus dem Shop nehmen
          </button>
        )}
        {issue.shopProductId && (
          <button
            className="btn secondary small"
            disabled={busy !== null}
            onClick={() =>
              run("refresh", async () => {
                await refresh({ issueId: issue._id });
                setMsg("Stand aus dem Shop geholt");
              })
            }
          >
            Status aktualisieren
          </button>
        )}
      </div>
      {msg && <div className="ok small">{msg}</div>}
      {err && <div className="err small">{err}</div>}
    </div>
  );
}
