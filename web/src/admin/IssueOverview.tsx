import { Link } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api, formatDate } from "../lib/api";
import { useFrage } from "../components/Frage";
import {
  JOB_KIND,
  JOB_STATUS,
  jobLaeuft,
  MeldungZeile,
  useMeldung,
  type EditorIssue,
} from "./adminUi";
import VeroeffentlichenKnopf from "./VeroeffentlichenKnopf";

type Punkt = {
  ok: boolean;
  /** Muss erledigt sein, bevor veroeffentlicht werden kann. */
  sperrt?: boolean;
  text: string;
  aktion?: React.ReactNode;
};

/**
 * Uebersicht eines Hefts: die Pruefliste vor dem Veroeffentlichen und der
 * Stand der Aufbereitung. Die Pruefliste zeigt, was `publishIssue` ohnehin
 * verlangt, und bietet die Abhilfe gleich daneben an.
 */
export default function IssueOverview({ issue }: { issue: EditorIssue }) {
  const frage = useFrage();
  const me = useQuery(api.users.me, {});
  const approveAll = useMutation(api.articles.approveAllPending);
  const enqueue = useMutation(api.imports.enqueue);
  const updateIssue = useMutation(api.issues.update);
  const [meldung, tue, busy] = useMeldung();
  const basis = `/admin/heft/${issue._id}`;
  const lastJob = issue.jobs[0] ?? null;
  const laeuft = jobLaeuft(lastJob?.status);

  const punkte: Punkt[] = [
    {
      ok: issue.pageCount > 0,
      sperrt: true,
      text: issue.pageCount ? `${issue.pageCount} Seiten` : "Noch keine Seiten",
      aktion: !issue.pageCount && (
        <Link className="btn quiet small" to={`${basis}/erweitert`}>
          Quellen hochladen
        </Link>
      ),
    },
    {
      ok: issue.articleCount > 0 && !laeuft && lastJob?.status !== "error",
      text: laeuft
        ? `Aufbereitung ${JOB_STATUS[lastJob!.status]}${lastJob?.progress ? ` (${Math.round(lastJob.progress)} %)` : ""}`
        : lastJob?.status === "error"
          ? "Aufbereitung fehlgeschlagen"
          : issue.articleCount
            ? `${issue.articleCount} Artikel erkannt`
            : "Noch nicht aufbereitet",
      aktion:
        !laeuft && issue.pageCount > 0 && !issue.articleCount ? (
          <button
            className="btn quiet small"
            disabled={busy !== null}
            onClick={() =>
              tue(() => enqueue({ issueId: issue._id, kind: "full" }), "Aufbereitung eingestellt")
            }
          >
            Aufbereitung starten
          </button>
        ) : null,
    },
    {
      ok: issue.pendingArticles === 0,
      sperrt: true,
      text:
        issue.pendingArticles > 0
          ? `${issue.pendingArticles} von ${issue.articleCount} Artikeln offen`
          : `Artikel entschieden: ${issue.approvedArticles} freigegeben, ${issue.excludedArticles} ausgeschlossen`,
      aktion: issue.pendingArticles > 0 && (
        <>
          <Link className="btn quiet small" to={`${basis}/artikel`}>
            Prüfen
          </Link>
          <button
            className="btn quiet small"
            disabled={busy !== null}
            onClick={async () => {
              const weiter = await frage({
                titel: `${issue.pendingArticles} offene Artikel freigeben?`,
                text: issue.isPublished
                  ? "Die Ausgabe ist veröffentlicht; die Artikel sind sofort sichtbar."
                  : undefined,
                ja: "Freigeben",
              });
              if (!weiter) return;
              await tue(
                () => approveAll({ issueId: issue._id }),
                (r) =>
                  `${r.approved} Artikel freigegeben` +
                  (r.remaining ? " — es sind noch weitere offen, bitte noch einmal." : ""),
              );
            }}
          >
            Alle freigeben
          </button>
        </>
      ),
    },
    {
      ok: !!issue.coverUrl,
      text: issue.coverUrl ? "Titelbild vorhanden" : "Kein Titelbild",
      aktion: !issue.coverUrl && (
        <Link className="btn quiet small" to={`${basis}/angaben`}>
          Titelbild wählen
        </Link>
      ),
    },
    {
      ok: issue.tocCount > 0,
      text: issue.tocCount ? `Inhaltsverzeichnis mit ${issue.tocCount} Einträgen` : "Kein Inhaltsverzeichnis",
      aktion: (
        <Link className="btn quiet small" to={`${basis}/inhalt`}>
          Ansehen
        </Link>
      ),
    },
    {
      ok: issue.includedInSubscription,
      text: issue.includedInSubscription ? "Im Abo enthalten" : "Nicht im Abo enthalten",
      aktion: (
        <button
          className="btn quiet small"
          disabled={busy !== null}
          onClick={() =>
            tue(
              () =>
                updateIssue({
                  issueId: issue._id,
                  includedInSubscription: !issue.includedInSubscription,
                }),
              issue.includedInSubscription ? "Aus dem Abo genommen" : "Ins Abo gegeben",
            )
          }
        >
          {issue.includedInSubscription ? "Aus dem Abo nehmen" : "Ins Abo geben"}
        </button>
      ),
    },
    {
      ok: !!issue.shopDigital?.offered,
      text: issue.shopDigital?.offered
        ? "Im Netzladen als E-Paper angeboten"
        : "Im Netzladen nicht als E-Paper angeboten",
      aktion: !issue.shopDigital?.offered && me?.isAdmin && (
        <Link className="btn quiet small" to={`${basis}/netzladen`}>
          Anbieten
        </Link>
      ),
    },
  ];

  return (
    <div className="heft-uebersicht">
      <section className="karte">
        <h3>Vor dem Veröffentlichen</h3>
        <ul className="pruefliste">
          {punkte.map((p) => (
            <li key={p.text} className={p.ok ? "ok" : p.sperrt ? "sperrt" : "offen"}>
              <span className="zeichen" aria-hidden="true">
                {p.ok ? "✓" : p.sperrt ? "!" : "–"}
              </span>
              <span className="text">{p.text}</span>
              {p.aktion ? <span className="aktion">{p.aktion}</span> : null}
            </li>
          ))}
        </ul>
        <MeldungZeile meldung={meldung} />
        {me?.isPublisher && (
          <div className="pruefliste-fuss">
            {issue.isPublished && issue.publishedAt ? (
              <span className="hint">Veröffentlicht am {formatDate(issue.publishedAt)}</span>
            ) : null}
            <VeroeffentlichenKnopf issue={issue} />
          </div>
        )}
      </section>

      <Auftraege issue={issue} />
    </div>
  );
}

function Auftraege({ issue }: { issue: EditorIssue }) {
  const cancel = useMutation(api.imports.cancel);
  const retry = useMutation(api.imports.retry);
  const [meldung, tue, busy] = useMeldung();
  if (!issue.jobs.length) return null;

  return (
    <section className="karte">
      <h3>Aufbereitung</h3>
      <ul className="auftraege">
        {issue.jobs.map((job) => (
          <li key={job._id}>
            <span className="was">
              {JOB_KIND[job.kind] ?? job.kind}
              <span className="hint small"> · {formatDate(job.createdAt)}</span>
            </span>
            <span
              className={`badge ${job.status === "error" ? "excluded" : jobLaeuft(job.status) ? "pending" : ""}`}
            >
              {JOB_STATUS[job.status] ?? job.status}
              {jobLaeuft(job.status) && job.progress ? ` ${Math.round(job.progress)} %` : ""}
            </span>
            {job.message && <span className="hint small nachricht">{job.message}</span>}
            <span className="aktion">
              {jobLaeuft(job.status) && (
                <button
                  className="btn quiet small"
                  disabled={busy !== null}
                  onClick={() => tue(() => cancel({ jobId: job._id }), "Abgebrochen")}
                >
                  Abbrechen
                </button>
              )}
              {job.status === "error" && (
                <button
                  className="btn quiet small"
                  disabled={busy !== null}
                  onClick={() => tue(() => retry({ jobId: job._id }), "Erneut eingestellt")}
                >
                  Erneut versuchen
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <MeldungZeile meldung={meldung} />
    </section>
  );
}
