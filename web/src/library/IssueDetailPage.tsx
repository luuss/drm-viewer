import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Authenticated, Unauthenticated, useAction, useQuery } from "convex/react";
import { api, formatEuro, formatDate, type Id , cleanError } from "../lib/api";
import Icon from "../components/Icon";
import ShopHinweis from "../components/ShopHinweis";

export default function IssueDetailPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const issueId = useQuery(api.issues.getBySlug, { slug: slug ?? "" });
  const issue = useQuery(
    api.issues.getPublic,
    issueId ? { issueId: issueId as Id<"issues"> } : "skip",
  );
  const waiver = useQuery(api.consents.currentWaiver, {});
  // Verkauft wird im Laden; der eigene Checkout ist nur per Schalter an.
  const storefront = useQuery(api.shopIntegration.storefront, {});
  const checkout = useAction(api.billing.createIssueCheckout);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (issueId === undefined || issue === undefined || storefront === undefined) {
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
          <img src={issue.coverUrl} alt={issue.displayTitle} />
        ) : (
          <div className="cover-placeholder">{issue.displayTitle[0]}</div>
        )}
      </div>
      <div className="issue-info">
        {issue.publicationName && issue.publicationName !== issue.displayTitle && (
          <div className="kicker">{issue.publicationName}</div>
        )}
        <h2>{issue.displayTitle}</h2>
        {issue.subtitle && <div className="subtitle">{issue.subtitle}</div>}
        <div className="meta">
          {issue.designation ? `${issue.designation} · ` : ""}
          {issue.pageCount} Seiten
          {issue.publicationDate ? ` · ${formatDate(issue.publicationDate)}` : ""}
        </div>
        {issue.description && issue.description !== issue.subtitle && (
          <p>{issue.description}</p>
        )}
        <div className="price">
          {formatEuro(issue.priceAmountCents)}
          <span className="hint"> inkl. MwSt.</span>
        </div>

        {storefront.stripeCheckout ? (
          <>
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
          </>
        ) : issue.owned ? (
          <button className="btn" onClick={() => navigate(`/reader/${issueId}`)}>
            Jetzt lesen
          </button>
        ) : (
          <>
            <div className="row actions">
              <a
                className="btn"
                href={issue.shopUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Im Shop kaufen <Icon name="arrow-right" />
              </a>
              <Unauthenticated>
                <button className="btn secondary" onClick={() => navigate("/")}>
                  Anmelden
                </button>
              </Unauthenticated>
            </div>
            <ShopHinweis />
          </>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
