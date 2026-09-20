import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, formatEuro, type Id } from "../lib/api";
import ImportWizard from "./ImportWizard";
import ArticleReview from "./ArticleReview";
import TocEditor from "./TocEditor";

type Tab = "import" | "articles" | "toc";

export default function AdminPage() {
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
      setErr(e?.message?.replace(/^\[.*?\]\s*/, "") ?? "Fehler");
    }
  }

  return (
    <div className="page admin">
      <h2>Redaktion</h2>
      <p className="hint">
        Angemeldet als <strong>{me.email}</strong> ({me.roles.join(", ")}).
      </p>

      <section>
        <h3>Titel</h3>
        <ul className="plain">
          {publications?.map((p) => (
            <li key={p._id}>
              {p.name} · {p.slug} {p.isActive ? "" : "· inaktiv"}
            </li>
          ))}
        </ul>
        {me.isAdmin && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const name = (e.currentTarget.elements.namedItem("name") as HTMLInputElement)
                .value;
              guard(() => createPublication({ name }), "Titel angelegt");
            }}
          >
            <input name="name" placeholder="Neuer Titel, z.B. ZUERST!" required />
            <button className="btn secondary">Anlegen</button>
          </form>
        )}
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
            size={8}
          />
          <input
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            size={6}
          />
          <button className="btn">Anlegen</button>
        </form>
      </section>

      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}

      <section>
        <h3>Ausgaben</h3>
        <ul className="admin-issues">
          {issues?.map((i) => (
            <li key={i._id}>
              <div className="row">
                <span className="grow">
                  <strong>{i.title}</strong>
                  {i.issueNumber ? ` · ${i.issueNumber}` : ""} · {i.pageCount} Seiten ·{" "}
                  {formatEuro(i.priceAmountCents)}
                  <span className="hint">
                    {" "}
                    · {i.isPublished ? "veröffentlicht" : "unveröffentlicht"} ·{" "}
                    {i.approvedArticles}/{i.articleCount} freigegeben
                    {i.pendingArticles > 0 ? ` · ${i.pendingArticles} offen` : ""}
                    {i.stripePriceId ? " · Preis in Stripe" : ""}
                    {i.lastJob
                      ? ` · Auftrag ${i.lastJob.status}${
                          i.lastJob.message ? `: ${i.lastJob.message}` : ""
                        }`
                      : ""}
                  </span>
                </span>
              </div>
              <div className="row actions">
                <button
                  className="link-btn"
                  onClick={() => setOpenIssue(openIssue === i._id ? null : i._id)}
                >
                  {openIssue === i._id ? "schliessen" : "bearbeiten"}
                </button>
                {me.isPublisher && (
                  <button
                    className="link-btn"
                    onClick={() =>
                      guard(
                        () => setPublished({ issueId: i._id, isPublished: !i.isPublished }),
                        i.isPublished ? "Zurückgezogen" : "Veröffentlicht",
                      )
                    }
                  >
                    {i.isPublished ? "zurückziehen" : "veröffentlichen"}
                  </button>
                )}
                <button
                  className="link-btn"
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
                  {i.includedInSubscription ? "aus Abo nehmen" : "ins Abo geben"}
                </button>
                {me.isPublisher && (
                  <button
                    className="link-btn"
                    onClick={() => guard(() => ensurePrice({ issueId: i._id }), "Preis angelegt")}
                  >
                    Stripe-Preis
                  </button>
                )}
                <button
                  className="link-btn"
                  onClick={() => guard(() => grantSelf({ issueId: i._id }), "Freigeschaltet")}
                >
                  mir freischalten
                </button>
                {i.lastJob?.status === "error" && (
                  <button
                    className="link-btn"
                    onClick={() => guard(() => retryJob({ jobId: i.lastJob!._id }), "Erneut eingestellt")}
                  >
                    Auftrag wiederholen
                  </button>
                )}
                {me.isPublisher && (
                  <button
                    className="link-btn danger"
                    onClick={() => {
                      if (confirm(`"${i.title}" endgültig löschen?`)) {
                        guard(() => removeIssue({ issueId: i._id }), "Gelöscht");
                      }
                    }}
                  >
                    löschen
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
                  {tab === "articles" && <ArticleReview issueId={i._id} />}
                  {tab === "toc" && <TocEditor issueId={i._id} />}
                </div>
              )}
            </li>
          ))}
          {issues?.length === 0 && <li className="hint">Noch keine Ausgabe.</li>}
        </ul>
      </section>
    </div>
  );
}
