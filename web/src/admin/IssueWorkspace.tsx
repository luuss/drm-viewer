import { Link, NavLink, useParams } from "react-router-dom";
import { useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import { heftStatus } from "./adminUi";
import VeroeffentlichenKnopf from "./VeroeffentlichenKnopf";
import IssueOverview from "./IssueOverview";
import IssueDetails from "./IssueDetails";
import ArticleReview from "./ArticleReview";
import TocEditor from "./TocEditor";
import PageLinksEditor from "./PageLinksEditor";
import IssueShop from "./IssueShop";
import IssueAdvanced from "./IssueAdvanced";

const REITER = [
  ["", "Übersicht"],
  ["angaben", "Angaben"],
  ["artikel", "Artikel"],
  ["inhalt", "Inhalt"],
  ["seiten", "Seiten & Links"],
  ["netzladen", "Netzladen"],
  ["erweitert", "Erweitert"],
] as const;

/**
 * Arbeitsplatz eines Hefts. Der Reiter steht in der Adresse: er bleibt je
 * Heft erhalten und laesst sich verlinken (die Heftliste springt etwa direkt
 * in die Artikelpruefung).
 */
export default function IssueWorkspace() {
  const { issueId, reiter = "" } = useParams();
  const id = issueId as Id<"issues">;
  const me = useQuery(api.users.me, {});
  const issue = useQuery(api.issues.getForEditor, { issueId: id });
  const lastJob = issue?.jobs[0] ?? null;

  if (issue === undefined) return <p className="hint">Laden...</p>;
  if (issue === null) {
    return (
      <div className="empty">
        <p>Dieses Heft gibt es nicht (mehr).</p>
        <Link className="btn secondary" to="/admin">
          Zu den Heften
        </Link>
      </div>
    );
  }

  const status = heftStatus({
    isPublished: issue.isPublished,
    pageCount: issue.pageCount,
    pendingArticles: issue.pendingArticles,
    lastJob: lastJob ? { status: lastJob.status, progress: lastJob.progress } : null,
  });
  const basis = `/admin/heft/${id}`;

  return (
    <section className="heft-arbeitsplatz">
      <header className="heft-kopf">
        <span className="heft-miniatur gross">
          {issue.coverUrl ? <img src={issue.coverUrl} alt="" /> : null}
        </span>
        <div className="heft-kopf-text">
          <Link to="/admin" className="zurueck">
            ← Hefte
          </Link>
          <h2>
            {issue.shopTitle ?? issue.title}
            {issue.issueNumber ? <span className="nummer"> Nr. {issue.issueNumber}</span> : null}
          </h2>
          <p className="hint">
            {issue.publicationName}
            {" · "}
            <span className={`badge ${status.ton}`}>{status.text}</span>
          </p>
        </div>
        <div className="heft-kopf-aktionen">
          <Link className="btn secondary" to={`/reader/${id}`} target="_blank">
            Vorschau
          </Link>
          {me?.isPublisher && <VeroeffentlichenKnopf issue={issue} />}
        </div>
      </header>

      <nav className="tabs heft-reiter" aria-label="Heft">
        {REITER.map(([pfad, text]) => (
          <NavLink
            key={pfad}
            to={pfad ? `${basis}/${pfad}` : basis}
            end
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            {text}
            {pfad === "artikel" && issue.pendingArticles > 0 ? (
              <span className="zaehler">{issue.pendingArticles}</span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="heft-reiter-inhalt">
        {reiter === "" && <IssueOverview issue={issue} />}
        {reiter === "angaben" && <IssueDetails issue={issue} />}
        {reiter === "artikel" && <ArticleReview issueId={id} />}
        {reiter === "inhalt" && <TocEditor issueId={id} />}
        {reiter === "seiten" && <PageLinksEditor issueId={id} />}
        {reiter === "netzladen" && <IssueShop issue={issue} />}
        {reiter === "erweitert" && <IssueAdvanced issue={issue} />}
      </div>
    </section>
  );
}
