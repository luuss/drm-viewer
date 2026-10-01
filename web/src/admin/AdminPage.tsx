import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api, formatEuro, type Id } from "../lib/api";
import { heftStatus, MeldungZeile, useMeldung } from "./adminUi";

type Heft = FunctionReturnType<typeof api.issues.overviewForEditors>[number];
type Filter = "alle" | "entwurf" | "live" | "probleme";

/**
 * Startseite der Redaktion: alle Hefte mit ihrem Stand. Je Zeile genau ein
 * Knopf fuer den naechsten Schritt; alles Weitere steht im Heft selbst.
 * Der Ordnerimport steht darueber (AdminLayout).
 */
export default function AdminPage() {
  const me = useQuery(api.users.me, {});
  const issues = useQuery(api.issues.overviewForEditors, {});
  const publications = useQuery(api.publications.listAll, {});
  const [reihe, setReihe] = useState("");
  const [filter, setFilter] = useState<Filter>("alle");

  const gezeigt = useMemo(() => {
    return (issues ?? []).filter((i) => {
      if (reihe && i.publicationId !== reihe) return false;
      const s = heftStatus(i);
      if (filter === "entwurf") return !i.isPublished;
      if (filter === "live") return i.isPublished;
      if (filter === "probleme") return s.schritt === "fehler" || s.schritt === "seiten";
      return true;
    });
  }, [issues, reihe, filter]);

  const probleme = (issues ?? []).filter((i) => {
    const s = heftStatus(i).schritt;
    return s === "fehler" || s === "seiten";
  }).length;

  return (
    <>
      <section className="admin-hefte">
        <div className="admin-hefte-kopf">
          <h2>Hefte</h2>
          <div className="admin-filter">
            <div className="segment" role="group" aria-label="Stand">
              {(
                [
                  ["alle", "Alle"],
                  ["entwurf", "Entwürfe"],
                  ["live", "Veröffentlicht"],
                  ["probleme", `Probleme${probleme ? ` (${probleme})` : ""}`],
                ] as [Filter, string][]
              ).map(([wert, text]) => (
                <button
                  key={wert}
                  type="button"
                  aria-pressed={filter === wert}
                  onClick={() => setFilter(wert)}
                >
                  {text}
                </button>
              ))}
            </div>
            {publications && publications.length > 1 && (
              <select
                value={reihe}
                onChange={(e) => setReihe(e.target.value)}
                aria-label="Reihe"
              >
                <option value="">Alle Reihen</option>
                {publications.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {issues === undefined ? (
          <p className="hint">Laden...</p>
        ) : gezeigt.length === 0 ? (
          <div className="empty">
            <p>
              {issues.length === 0
                ? "Noch kein Heft. Den ersten Heftordner oben ablegen."
                : "Kein Heft in dieser Auswahl."}
            </p>
          </div>
        ) : (
          <ul className="heft-liste">
            {gezeigt.map((i) => (
              <HeftZeile key={i._id} heft={i} darfVeroeffentlichen={!!me?.isPublisher} />
            ))}
          </ul>
        )}
      </section>

      <NeueAusgabe />
    </>
  );
}

function HeftZeile({ heft: i, darfVeroeffentlichen }: { heft: Heft; darfVeroeffentlichen: boolean }) {
  const navigate = useNavigate();
  const setPublished = useMutation(api.issues.setPublished);
  const retryJob = useMutation(api.imports.retry);
  const [meldung, tue, busy] = useMeldung();
  const status = heftStatus(i);
  const ziel = `/admin/heft/${i._id}`;

  let knopf: React.ReactNode;
  if (status.schritt === "fehler" && i.lastJob) {
    knopf = (
      <button
        className="btn small"
        disabled={busy !== null}
        aria-busy={busy !== null}
        onClick={() => tue(() => retryJob({ jobId: i.lastJob!._id }), "Erneut eingestellt")}
      >
        Erneut versuchen
      </button>
    );
  } else if (status.schritt === "pruefen") {
    knopf = (
      <Link className="btn small" to={`${ziel}/artikel`}>
        Prüfen
      </Link>
    );
  } else if (status.schritt === "bereit" && darfVeroeffentlichen) {
    knopf = (
      <button
        className="btn small"
        disabled={busy !== null}
        aria-busy={busy !== null}
        onClick={() =>
          tue(() => setPublished({ issueId: i._id, isPublished: true }), "Veröffentlicht")
        }
      >
        Veröffentlichen
      </button>
    );
  } else {
    knopf = (
      <Link className="btn secondary small" to={ziel}>
        Öffnen
      </Link>
    );
  }

  return (
    <li className="heft-zeile">
      <button
        type="button"
        className="heft-zeile-inhalt"
        onClick={() => navigate(ziel)}
        aria-label={`${i.displayTitle} öffnen`}
      >
        <span className="heft-miniatur">
          {i.coverUrl ? <img src={i.coverUrl} alt="" loading="lazy" /> : null}
        </span>
        <span className="heft-name">
          <span className="titel">{i.displayTitle}</span>
          <span className="meta">
            {[
              i.publicationName,
              i.issueNumber && `Nr. ${i.issueNumber}`,
              i.pageCount ? `${i.pageCount} Seiten` : null,
              formatEuro(i.priceAmountCents),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="heft-stand">
          <span className={`badge ${status.ton}`}>{status.text}</span>
          {i.isPublished && !i.shopOffered && (
            <span className="hint small">nicht im Netzladen angeboten</span>
          )}
          {status.schritt === "fehler" && i.lastJob?.message && (
            <span className="hint small">{i.lastJob.message}</span>
          )}
        </span>
      </button>
      <span className="heft-aktion">{knopf}</span>
      {meldung && (
        <div className="heft-meldung">
          <MeldungZeile meldung={meldung} klein />
        </div>
      )}
    </li>
  );
}

/**
 * Ausgabe ohne Heftordner anlegen — selten gebraucht, deshalb zugeklappt.
 * Der Normalfall ist der Ordner oben.
 */
function NeueAusgabe() {
  const navigate = useNavigate();
  const publications = useQuery(api.publications.listAll, {});
  const createIssue = useMutation(api.issues.create);
  const [meldung, tue, busy] = useMeldung();
  const [publicationId, setPublicationId] = useState("");
  const [title, setTitle] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [price, setPrice] = useState("9.99");

  return (
    <details className="aufklapp neue-ausgabe">
      <summary>Ausgabe ohne Heftordner anlegen</summary>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void tue(async () => {
            if (!publicationId) throw new Error("Bitte eine Reihe wählen");
            const id = await createIssue({
              publicationId: publicationId as Id<"publications">,
              title,
              issueNumber: issueNumber || undefined,
              priceAmountCents: Math.round(parseFloat(price) * 100),
            });
            navigate(`/admin/heft/${id}/erweitert`);
          });
        }}
      >
        <label>
          Reihe
          <select value={publicationId} onChange={(e) => setPublicationId(e.target.value)} required>
            <option value="">wählen</option>
            {publications?.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Titel der Ausgabe
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="schmal">
          Heftnummer
          <input value={issueNumber} onChange={(e) => setIssueNumber(e.target.value)} />
        </label>
        <label className="schmal">
          Preis in €
          <input
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </label>
        <button className="btn" disabled={busy !== null} aria-busy={busy !== null}>
          Anlegen
        </button>
      </form>
      <MeldungZeile meldung={meldung} />
    </details>
  );
}
