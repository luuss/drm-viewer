import { useAction, useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/api";
import { useFrage } from "../components/Frage";
import { MeldungZeile, useMeldung } from "./adminUi";

function zeitpunkt(ms: number): string {
  return new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

/**
 * Mail an die Kaeufer zum neuen Heft (convex/heftAnkuendigung.ts): Stand,
 * Probe an die eigene Adresse, vorziehen und anhalten.
 */
export default function HeftAnkuendigung({
  issue,
}: {
  issue: { _id: Id<"issues">; isPublished: boolean };
}) {
  const frage = useFrage();
  const me = useQuery(api.users.me, {});
  const stand = useQuery(api.heftAnkuendigung.fuerRedaktion, { issueId: issue._id });
  const probe = useAction(api.heftAnkuendigung.probe);
  const stoppen = useMutation(api.heftAnkuendigung.stoppen);
  const jetzt = useMutation(api.heftAnkuendigung.jetztSenden);
  const [meldung, tue, busy] = useMeldung();
  if (!stand) return null;

  const a = stand.ankuendigung;
  const darf = !!me?.isPublisher && !stand.abgeschaltet;
  const verschickt = a ? `${a.gesendet} von ${a.empfaenger - a.abgemeldet}` : "";

  let text: string;
  if (stand.abgeschaltet) text = "Abgeschaltet (HEFT_ANKUENDIGUNG).";
  else if (!a) {
    text = issue.isPublished
      ? "Dieses Heft wurde nicht angekündigt."
      : "Nach dem ersten Veröffentlichen bekommen alle Käufer eine Mail, 30 Minuten später und nicht nachts.";
  } else if (a.status === "geplant") text = `Geplant für ${zeitpunkt(a.geplantFuer)}.`;
  else if (a.status === "sammelt") text = "Empfänger werden gesammelt …";
  else if (a.status === "sendet") text = `Wird verschickt: ${verschickt}.`;
  else if (a.status === "fertig") text = `Verschickt${a.fertigAm ? ` am ${zeitpunkt(a.fertigAm)}` : ""}: ${a.gesendet} Mails.`;
  else if (a.grund === "zurueckgezogen")
    text = `Angehalten, weil das Heft zurückgezogen ist (${verschickt} verschickt). Geht beim Veröffentlichen weiter.`;
  else text = `Angehalten (${verschickt} verschickt).`;

  const nebenbei = a && (a.fehler > 0 || a.abgemeldet > 0)
    ? [a.fehler ? `${a.fehler} nicht zustellbar` : null, a.abgemeldet ? `${a.abgemeldet} abbestellt` : null]
        .filter(Boolean)
        .join(" · ")
    : null;

  const kannSenden = darf && issue.isPublished && (!a || a.status === "geplant" || a.status === "abgebrochen");
  const kannStoppen = darf && a && (a.status === "geplant" || a.status === "sammelt" || a.status === "sendet");

  return (
    <section className="karte">
      <h3>Mail an die Käufer</h3>
      <p className="hint">{text}</p>
      {nebenbei && <p className="hint small">{nebenbei}</p>}
      <div className="knopfreihe">
        {kannSenden && (
          <button
            className="btn small"
            disabled={busy !== null}
            onClick={async () => {
              const ok = await frage({
                titel: "Mail jetzt verschicken?",
                text: "Alle Käufer bekommen die Mail zu diesem Heft sofort. Wer sie schon hat, bekommt sie nicht noch einmal.",
                ja: "Jetzt verschicken",
              });
              if (ok) tue(() => jetzt({ issueId: issue._id }), "Versand läuft an.");
            }}
          >
            {!a ? "Jetzt ankündigen" : a.status === "geplant" ? "Sofort senden" : "Weiter senden"}
          </button>
        )}
        {kannStoppen && (
          <button
            className="btn secondary small"
            disabled={busy !== null}
            onClick={() => tue(() => stoppen({ issueId: issue._id }), "Angehalten.")}
          >
            {a!.status === "geplant" ? "Nicht senden" : "Anhalten"}
          </button>
        )}
        <button
          className="btn quiet small"
          disabled={busy !== null}
          onClick={() => tue(() => probe({ issueId: issue._id }), (r) => `Probe an ${r.an} verschickt.`)}
        >
          Probe an mich
        </button>
      </div>
      <MeldungZeile meldung={meldung} klein />
    </section>
  );
}
