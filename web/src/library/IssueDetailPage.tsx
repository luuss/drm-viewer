import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Authenticated, Unauthenticated, useAction, useQuery } from "convex/react";
import { api, formatEuro, formatDate, type Id , cleanError } from "../lib/api";

export default function IssueDetailPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const issueId = useQuery(api.issues.getBySlug, { slug: slug ?? "" });
  const issue = useQuery(
    api.issues.getPublic,
    issueId ? { issueId: issueId as Id<"issues"> } : "skip",
  );
  const waiver = useQuery(api.consents.currentWaiver, {});
  const checkout = useAction(api.billing.createIssueCheckout);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (issueId === undefined || issue === undefined) {
    return <div className="centered">Laden...</div>;
  }
  if (!issueId || !issue) return <div className="centered">Ausgabe nicht gefunden</div>;

  async function buy() {
    setErr(null);
    setBusy(true);
    try {
      const origin = window.location.origin;
      const { url } = await checkout({
        issueId: issueId as Id<"issues">,
        successUrl: `${origin}/library?gekauft=${issueId}`,
        cancelUrl: `${origin}/issue/${slug}`,
        withdrawalWaiver: accepted,
      });
      window.location.href = url;
    } catch (e: any) {
      setErr(cleanError(e) ?? "Kauf fehlgeschlagen");
      setBusy(false);
    }
  }

  return (
    <div className="page issue-detail">
      <div className="cover-wrap">
        {issue.coverUrl ? (
          <img src={issue.coverUrl} alt={issue.title} />
        ) : (
          <div className="cover-placeholder">{issue.title[0]}</div>
        )}
      </div>
      <div className="issue-info">
        <h2>{issue.title}</h2>
        <div className="meta">
          {issue.issueNumber ? `${issue.issueNumber} · ` : ""}
          {issue.pageCount} Seiten
          {issue.publicationDate ? ` · ${formatDate(issue.publicationDate)}` : ""}
        </div>
        {issue.description && <p>{issue.description}</p>}
        <div className="price">
          {formatEuro(issue.priceAmountCents)}
          <span className="hint"> inkl. MwSt.</span>
        </div>

        <Authenticated>
          {issue.owned ? (
            <button className="btn" onClick={() => navigate(`/reader/${issueId}`)}>
              Jetzt lesen
            </button>
          ) : (
            <>
              <label className="consent">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  {waiver?.text ??
                    "Ich verlange den sofortigen Zugriff und verliere damit mein Widerrufsrecht."}{" "}
                  (<Link to="/widerruf">Widerrufsbelehrung</Link>)
                </span>
              </label>
              <button
                className="btn"
                onClick={buy}
                disabled={busy || !accepted}
                aria-busy={busy}
              >
                {busy ? "Wird geöffnet..." : "Kaufen"}
              </button>
            </>
          )}
        </Authenticated>
        <Unauthenticated>
          <button className="btn" onClick={() => navigate("/")}>
            Zum Kauf anmelden
          </button>
        </Unauthenticated>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
