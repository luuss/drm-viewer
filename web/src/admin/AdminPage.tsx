import { useState } from "react";
import { useFrage } from "../components/Frage";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, formatEuro, type Id , cleanError } from "../lib/api";
import ImportWizard from "./ImportWizard";
import FolderImport from "./FolderImport";
import ArticleReview from "./ArticleReview";
import TocEditor from "./TocEditor";
import ExtractionDebug from "./ExtractionDebug";

type Tab = "import" | "debug" | "articles" | "toc";

export default function AdminPage() {
  const frage = useFrage();
  const me = useQuery(api.users.me, {});
  const publications = useQuery(api.publications.listAll, {});
  const issues = useQuery(api.issues.listForEditors, {});
  const createPublication = useMutation(api.publications.create);
  const createIssue = useMutation(api.issues.create);
  const updateIssue = useMutation(api.issues.update);
  const setPublished = useMutation(api.issues.setPublished);
  const removeIssue = useMutation(api.issues.remove);
  const grantSelf = useMutation(api.entitlements.grantMyself);
  const ensurePrice = useAction(api.billing.ensureIssuePrice);
  const ladenAbgleich = useAction(api.publicationCovers.refreshNow);
  const [ladenLaeuft, setLadenLaeuft] = useState(false);
  const retryJob = useMutation(api.imports.retry);

  const [openIssue, setOpenIssue] = useState<Id<"issues"> | null>(null);
  const [tab, setTab] = useState<Tab>("import");
  const [title, setTitle] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [price, setPrice] = useState("9.99");
  const [publicationId, setPublicationId] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (me === undefined) return <div className="centered">Laden...</div>;
  if (!me?.isEditor) {
    return (
      <div className="centered">
        <h2>Kein Zugriff</h2>
        <p>Dieser Bereich ist der Redaktion vorbehalten.</p>
      </div>
    );
  }

  async function guard(fn: () => Promise<unknown>, okMessage?: string) {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (okMessage) setMsg(okMessage);
    } catch (e: any) {
      setErr(cleanError(e) ?? "Fehler");
    }
  }

  return (
    <div className="page admin">
      <div className="page-head">
        <h2>Redaktion</h2>
        <p className="hint">
          Angemeldet als <strong>{me.email}</strong> · {me.roles.join(", ")}
        </p>
      </div>

      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}

      <section>
        <h3>Titel</h3>
        <ul className="chip-list">
          {publications?.map((p) => (
            <li key={p._id}>
              {p.name} <span className="muted">/{p.slug}</span>
              {p.isActive ? "" : " · inaktiv"}
            </li>
          ))}
        </ul>
        {me.isAdmin && (
          <form
            className="inline-form short"
            onSubmit={(e) => {
              e.preventDefault();
              const name = (e.currentTarget.elements.namedItem("name") as HTMLInputElement)
                .value;
              guard(() => createPublication({ name }), "Titel angelegt");
            }}
          >
            <input name="name" placeholder="Neuer Titel, z.B. ZUERST!" required />
            <button className="btn">Anlegen</button>
          </form>
        )}
        {/* Den Verkaufspreis fuehrt der Netzladen. Nachts laeuft der Abgleich
            von selbst; hier laesst er sich nach einer Preisaenderung sofort
            anstossen. */}
        <p className="muted small">
          Preise, Titelbilder und Heftbezeichnungen kommen aus dem Verlagsshop.
        </p>
        <button
          className="btn secondary"
          disabled={ladenLaeuft}
          onClick={async () => {
            setLadenLaeuft(true);
            await guard(async () => {
              const ergebnis = await ladenAbgleich({});
              const teile = [`${ergebnis.issues.length} Hefte abgeglichen`];
              if (ergebnis.missing.length) {
                teile.push(`${ergebnis.missing.length} nicht gefunden`);
              }
              if (ergebnis.failed.length) {
                teile.push(`${ergebnis.failed.length} fehlgeschlagen`);
              }
              setMsg(teile.join(" · "));
            });
            setLadenLaeuft(false);
          }}
        >
          {ladenLaeuft ? "Wird abgeglichen…" : "Aus dem Verlagsshop aktualisieren"}
        </button>
      </section>

      <section>
        <h3>Heftordner einlesen</h3>
        <p className="hint">
          Der Ordner aus der Druckvorstufe, wie er kommt. Reihe und Heftnummer
          stehen im Namen, die Rollen der Dateien im Aufbau. Die Bilder werden
          im Browser umgerechnet; hochgeladen wird nur, was zum Lesen gebraucht
          wird.
        </p>
        <FolderImport
          onIssue={(id) => {
            setOpenIssue(id);
            setTab("import");
          }}
        />
      </section>

      <section>
        <h3>Neue Ausgabe</h3>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!publicationId) {
              setErr("Bitte einen Titel wählen");
              return;
            }
            guard(async () => {
              const id = await createIssue({
                publicationId: publicationId as Id<"publications">,
                title,
                issueNumber: issueNumber || undefined,
                priceAmountCents: Math.round(parseFloat(price) * 100),
              });
              setOpenIssue(id);
              setTitle("");
              setIssueNumber("");
            }, "Ausgabe angelegt");
          }}
        >
          <select
            value={publicationId}
            onChange={(e) => setPublicationId(e.target.value)}
            required
          >
            <option value="">Titel wählen</option>
            {publications?.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titel der Ausgabe"
            required
          />
          <input
            value={issueNumber}
            onChange={(e) => setIssueNumber(e.target.value)}
            placeholder="Heftnummer"
            className="narrow"
          />
          <div className="money">
            <span>€</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
              aria-label="Preis in Euro"
            />
          </div>
          <button className="btn">Anlegen</button>
        </form>
      </section>

      <section>
        <h3>Ausgaben</h3>
        <ul className="admin-issues">
          {issues?.map((i) => (
            <li key={i._id}>
              <div className="issue-line">
                <div className="name">
                  {i.title}
                  {i.issueNumber ? <span className="number"> {i.issueNumber}</span> : null}
                </div>
                <div className="facts">
                  <span className={`badge ${i.isPublished ? "live" : ""}`}>
                    {i.isPublished ? "veröffentlicht" : "Entwurf"}
                  </span>
                  <span>{i.pageCount} Seiten</span>
                  <span className="sep">·</span>
                  <span>{formatEuro(i.priceAmountCents)}</span>
                  <span className="sep">·</span>
                  <span>
                    {i.approvedArticles}/{i.articleCount} freigegeben
                  </span>
                  {i.pendingArticles > 0 && (
                    <span className="badge pending">{i.pendingArticles} offen</span>
                  )}
                  {i.stripePriceId && <span className="badge">Stripe</span>}
                  {i.lastJob && (
                    <span className={`badge ${i.lastJob.status === "error" ? "excluded" : ""}`}>
                      Import: {i.lastJob.status}
                    </span>
                  )}
                </div>
                {i.lastJob?.message && <div className="job-note">{i.lastJob.message}</div>}
              </div>
              <div className="row actions">
                <button
                  className={openIssue === i._id ? "btn secondary small" : "btn small"}
                  onClick={() => setOpenIssue(openIssue === i._id ? null : i._id)}
                >
                  {openIssue === i._id ? "Schliessen" : "Bearbeiten"}
                </button>
                {me.isPublisher && (
                  <button
                    className="btn secondary small"
                    onClick={() =>
                      guard(
                        () => setPublished({ issueId: i._id, isPublished: !i.isPublished }),
                        i.isPublished ? "Zurückgezogen" : "Veröffentlicht",
                      )
                    }
                  >
                    {i.isPublished ? "Zurückziehen" : "Veröffentlichen"}
                  </button>
                )}
                <button
                  className="btn secondary small"
                  onClick={() =>
                    guard(
                      () =>
                        updateIssue({
                          issueId: i._id,
                          includedInSubscription: !i.includedInSubscription,
                        }),
                      "Gespeichert",
                    )
                  }
                >
                  {i.includedInSubscription ? "Aus Abo nehmen" : "Ins Abo geben"}
                </button>
                {me.isPublisher && (
                  <button
                    className="btn secondary small"
                    onClick={() => guard(() => ensurePrice({ issueId: i._id }), "Preis angelegt")}
                  >
                    Stripe-Preis
                  </button>
                )}
                <button
                  className="btn secondary small"
                  onClick={() => guard(() => grantSelf({ issueId: i._id }), "Freigeschaltet")}
                >
                  Mir freischalten
                </button>
                {i.lastJob?.status === "error" && (
                  <button
                    className="btn secondary small"
                    onClick={() => guard(() => retryJob({ jobId: i.lastJob!._id }), "Erneut eingestellt")}
                  >
                    Auftrag wiederholen
                  </button>
                )}
                {me.isPublisher && (
                  <button
                    className="btn secondary small danger"
                    onClick={async () => {
                      const weiter = await frage({
                        titel: "Ausgabe endgültig löschen?",
                        text: `„${i.title}“ verschwindet mit allen Seiten, Artikeln und Dateien. Käufe bleiben bestehen, zeigen aber ins Leere.`,
                        ja: "Löschen",
                        gefahr: true,
                      });
                      if (weiter) guard(() => removeIssue({ issueId: i._id }), "Gelöscht");
                    }}
                  >
                    Löschen
                  </button>
                )}
              </div>

              {openIssue === i._id && (
                <div className="issue-workspace">
                  <nav className="tabs">
                    <button
                      className={tab === "import" ? "active" : ""}
                      onClick={() => setTab("import")}
                    >
                      Import
                    </button>
                    <button
                      className={tab === "debug" ? "active" : ""}
                      onClick={() => setTab("debug")}
                    >
                      Extraktion
                    </button>
                    <button
                      className={tab === "articles" ? "active" : ""}
                      onClick={() => setTab("articles")}
                    >
                      Artikel
                    </button>
                    <button
                      className={tab === "toc" ? "active" : ""}
                      onClick={() => setTab("toc")}
                    >
                      Inhalt
                    </button>
                  </nav>
                  {tab === "import" && <ImportWizard issueId={i._id} />}
                  {tab === "debug" && <ExtractionDebug issueId={i._id} />}
                  {tab === "articles" && <ArticleReview issueId={i._id} />}
                  {tab === "toc" && <TocEditor issueId={i._id} />}
                </div>
              )}
            </li>
          ))}
          {issues?.length === 0 && (
            <li className="empty">
              <p>Noch keine Ausgabe angelegt.</p>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
