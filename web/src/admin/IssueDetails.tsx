import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api, formatEuro } from "../lib/api";
import { uploadAsset } from "./uploadAsset";
import { MeldungZeile, useMeldung, type EditorIssue } from "./adminUi";

const PREIS_HERKUNFT: Record<string, string> = {
  laden: "aus dem Netzladen",
  impressum: "aus dem Impressum",
  redaktion: "von Hand eingetragen",
};

/** Datum als yyyy-mm-dd fuer das Datumsfeld, in Ortszeit. */
function alsDatum(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const zwei = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}

/**
 * Angaben einer Ausgabe. Was der Netzladen fuehrt (Name, Heftbezeichnung),
 * steht zur Kenntnis daneben: der Kiosk zeigt es vor dem eigenen Titel.
 */
export default function IssueDetails({ issue }: { issue: EditorIssue }) {
  const updateIssue = useMutation(api.issues.update);
  const [meldung, tue, busy] = useMeldung();

  return (
    <div className="heft-angaben">
      <form
        className="karte stack-form breit"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget.elements;
          const wert = (name: string) =>
            (f.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value;
          const preis = Math.round(parseFloat(wert("preis").replace(",", ".")) * 100);
          const datum = wert("datum");
          void tue(
            () =>
              updateIssue({
                issueId: issue._id,
                title: wert("titel").trim(),
                issueNumber: wert("nummer").trim(),
                description: wert("beschreibung").trim(),
                publicationDate: datum ? new Date(`${datum}T12:00:00`).getTime() : undefined,
                priceAmountCents:
                  Number.isFinite(preis) && preis !== issue.priceAmountCents ? preis : undefined,
              }),
            "Angaben gespeichert",
          );
        }}
      >
        <h3>Angaben</h3>
        {issue.shopTitle && (
          <p className="hint">
            Im Kiosk steht der Name aus dem Netzladen: <strong>{issue.shopTitle}</strong>
            {issue.shopDesignation ? ` · ${issue.shopDesignation}` : ""}
            {issue.shopSubtitle ? ` · ${issue.shopSubtitle}` : ""}
          </p>
        )}
        <label>
          Titel der Ausgabe
          <input name="titel" defaultValue={issue.title} required />
        </label>
        <div className="feld-reihe">
          <label className="schmal">
            Heftnummer
            <input name="nummer" defaultValue={issue.issueNumber ?? ""} />
          </label>
          <label className="schmal">
            Erscheinungsdatum
            <input name="datum" type="date" defaultValue={alsDatum(issue.publicationDate)} />
          </label>
          <label className="schmal">
            Preis in €
            <input
              name="preis"
              inputMode="decimal"
              defaultValue={(issue.priceAmountCents / 100).toFixed(2)}
              required
            />
          </label>
        </div>
        <p className="hint">
          Preis {formatEuro(issue.priceAmountCents)}
          {issue.priceSource ? `, ${PREIS_HERKUNFT[issue.priceSource] ?? issue.priceSource}` : ""}.
          {issue.priceSource === "redaktion"
            ? " Ein Preis von Hand bleibt stehen, auch wenn der Netzladen etwas anderes führt."
            : " Der nächtliche Abgleich mit dem Netzladen kann ihn überschreiben."}
          {issue.priceSource === "redaktion" && (
            <>
              {" "}
              <button
                type="button"
                className="btn quiet small"
                disabled={busy !== null}
                onClick={() =>
                  tue(
                    () => updateIssue({ issueId: issue._id, priceAuto: true }),
                    "Der Preis kommt beim nächsten Abgleich aus dem Netzladen",
                  )
                }
              >
                Dem Netzladen überlassen
              </button>
            </>
          )}
        </p>
        <label>
          Beschreibung
          <textarea
            name="beschreibung"
            rows={4}
            defaultValue={issue.description ?? ""}
          />
        </label>
        <label className="consent">
          <input
            type="checkbox"
            checked={issue.includedInSubscription}
            onChange={(e) =>
              tue(
                () =>
                  updateIssue({
                    issueId: issue._id,
                    includedInSubscription: e.target.checked,
                  }),
                e.target.checked ? "Ins Abo gegeben" : "Aus dem Abo genommen",
              )
            }
          />
          Im Abo enthalten
        </label>
        <button className="btn" disabled={busy !== null} aria-busy={busy !== null}>
          Speichern
        </button>
        <MeldungZeile meldung={meldung} />
      </form>

      <Titelbild issue={issue} />
    </div>
  );
}

function Titelbild({ issue }: { issue: EditorIssue }) {
  const generateUploadUrl = useMutation(api.assets.generateUploadUrl);
  const presignUpload = useAction(api.uploads.presignUpload);
  const registerUpload = useMutation(api.assets.registerUpload);
  const updateIssue = useMutation(api.issues.update);
  const [meldung, tue, busy] = useMeldung();
  const [eingabe, setEingabe] = useState(0);

  return (
    <section className="karte titelbild-karte">
      <h3>Titelbild</h3>
      <span className="heft-miniatur titelbild">
        {issue.coverUrl ? <img src={issue.coverUrl} alt="Titelbild" /> : null}
      </span>
      <label className="upload">
        Anderes Bild (JPEG oder PNG)
        <input
          key={eingabe}
          type="file"
          accept="image/jpeg,image/png"
          disabled={busy !== null}
          onChange={(e) => {
            const datei = e.target.files?.[0];
            if (!datei) return;
            void tue(async () => {
              const { assetId } = await uploadAsset(
                { presignUpload, registerUpload, generateUploadUrl },
                issue._id,
                datei,
                datei.name,
                "cover",
              );
              await updateIssue({ issueId: issue._id, coverAssetId: assetId });
            }, "Titelbild ersetzt").finally(() => setEingabe((n) => n + 1));
          }}
        />
      </label>
      {busy && <p className="hint">Wird hochgeladen…</p>}
      <MeldungZeile meldung={meldung} />
    </section>
  );
}
