import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, type Id , cleanError } from "../lib/api";
import { buildPageOrder, type CoverLayout, type PageDraft as Draft } from "./pageOrder";
import { countPdfPages, uploadAsset } from "./uploadAsset";

type PageDraft = Draft<Id<"assets">>;

type SourceDraft = {
  assetId: Id<"assets">;
  kind: "pdf" | "idml" | "indd";
  role: "inner" | "cover" | "supplemental" | "archive";
  filename: string;
  pageCount: number;
};

/**
 * Importdialog: Quellen hochladen, Leserreihenfolge bestaetigen, Auftrag
 * einstellen. Der Vorschlag fuer den Umschlag folgt der Bogenreihenfolge
 * (U4, U1, U2, U3), ist aber nur ein Vorschlag.
 */
export default function ImportWizard({ issueId }: { issueId: Id<"issues"> }) {
  const generateUploadUrl = useMutation(api.assets.generateUploadUrl);
  const presignUpload = useAction(api.uploads.presignUpload);
  const registerUpload = useMutation(api.assets.registerUpload);
  const addSource = useMutation(api.issueSources.add);
  const setPageCount = useMutation(api.issueSources.setPageCount);
  const sources = useQuery(api.issueSources.listForIssue, { issueId });
  const setOrder = useMutation(api.issuePages.setOrder);
  const enqueue = useMutation(api.imports.enqueue);
  const existingPages = useQuery(api.issuePages.listForEditors, { issueId });

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pages, setPages] = useState<PageDraft[] | null>(null);
  const [printedStart, setPrintedStart] = useState("3");
  const [coverLayout, setCoverLayout] = useState<CoverLayout>("auto");

  async function upload(
    file: File,
    kind: SourceDraft["kind"],
    role: SourceDraft["role"],
  ) {
    setErr(null);
    setBusy(`Lade ${file.name}`);
    try {
      const assetId = await uploadAsset(
        { presignUpload, registerUpload, generateUploadUrl },
        issueId,
        file,
        file.name,
      );
      const pageCount = kind === "pdf" ? await countPdfPages(file) : undefined;
      await addSource({ issueId, assetId, kind, role, filename: file.name, pageCount });
      setMsg(
        pageCount
          ? `${file.name} hochgeladen, ${pageCount} Seiten`
          : `${file.name} hochgeladen – Seitenzahl bitte eintragen`,
      );
    } catch (e: any) {
      setErr(cleanError(e));
    } finally {
      setBusy(null);
    }
  }

  function buildProposal() {
    const list = (sources ?? [])
      .filter((s: any) => s.kind === "pdf")
      .map((s: any) => ({ ...s, pageCount: s.pageCount ?? 0 }));
    const cover = list.find((s: any) => s.role === "cover");
    const inner = list.find((s: any) => s.role === "inner") ?? list[0];
    const coverImage = (sources ?? []).find(
      (s: any) => s.kind === "image" && s.role === "cover",
    );
    if (!inner) {
      setErr("Mindestens ein Innenteil-PDF wird gebraucht");
      return;
    }
    setPages(
      buildPageOrder<Id<"assets">>({
        inner: { assetId: inner.assetId, pageCount: inner.pageCount },
        cover: cover
          ? { assetId: cover.assetId, pageCount: cover.pageCount }
          : undefined,
        coverImageAssetId: coverImage?.assetId,
        layout: coverLayout,
        printedStart: Number(printedStart) || 1,
      }),
    );
  }

  function move(index: number, delta: number) {
    if (!pages) return;
    const next = [...pages];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPages(next);
  }

  return (
    <div className="wizard">
      {/* Jeder Schritt ist ein eigener Abschnitt mit fester Luecke. Vorher
          standen Ueberschrift, Felder und Hinweise aller drei Schritte in
          einem Stapel und waren nicht auseinanderzuhalten. */}
      <section>
        <h4>1. Quellen</h4>
        <div className="upload-row">
          <label className="upload">
            Innenteil (PDF)
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) =>
                e.target.files?.[0] && upload(e.target.files[0], "pdf", "inner")
              }
            />
          </label>
          <label className="upload">
            Umschlag (PDF)
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) =>
                e.target.files?.[0] && upload(e.target.files[0], "pdf", "cover")
              }
            />
          </label>
          <label className="upload">
            Satzdatei (IDML)
            <input
              type="file"
              accept=".idml"
              onChange={(e) =>
                e.target.files?.[0] && upload(e.target.files[0], "idml", "supplemental")
              }
            />
          </label>
          <label className="upload">
            Archiv (INDD)
            <input
              type="file"
              accept=".indd"
              onChange={(e) =>
                e.target.files?.[0] && upload(e.target.files[0], "indd", "archive")
              }
            />
          </label>
        </div>
        <p className="hint">
          Eine .indd-Datei wird nur archiviert; Innenteil und Umschlag dürfen je
          eine eigene haben. Für die automatische Auswertung in InDesign bitte
          zusätzlich als IDML exportieren (Datei → Exportieren → InDesign Markup).
        </p>
        <ul className="source-list">
          {sources?.map((s: any) => (
            <li key={s._id}>
              <span className="badge">{s.role}</span>
              <span className="grow">{s.filename}</span>
              <span className="muted">{s.kind}</span>
              {s.kind === "pdf" && (
                <label className="muted">
                  <input
                    className="narrow"
                    inputMode="numeric"
                    defaultValue={s.pageCount ?? ""}
                    placeholder="?"
                    aria-label={`Seitenzahl von ${s.filename}`}
                    onBlur={(e) => {
                      const n = Number(e.target.value);
                      if (n > 0 && n !== s.pageCount) {
                        setPageCount({ sourceId: s._id, pageCount: n }).catch((err) =>
                          setErr(cleanError(err)),
                        );
                      }
                    }}
                  />{" "}
                  Seiten
                </label>
              )}
            </li>
          ))}
          {sources?.length === 0 && (
            <li className="empty">Noch keine Quelle hochgeladen.</li>
          )}
        </ul>
      </section>

      <section>
        <h4>2. Leserreihenfolge</h4>
        <div className="order-row">
          <label className="narrow-field">
            Umschlagdatei
            <select
              value={coverLayout}
              onChange={(e) => setCoverLayout(e.target.value as CoverLayout)}
            >
              <option value="auto">Automatisch nach Seitenzahl</option>
              <option value="sheets">Vier Einzelseiten in Bogenreihenfolge (U4, U1, U2, U3)</option>
              <option value="spreads">Zwei Doppelseiten (U4|U1, U2|U3)</option>
              <option value="reading">Einzelseiten in Leserreihenfolge (U1 … U4)</option>
            </select>
          </label>
          <label className="narrow-field">
            Erste Innenseite trägt Seitenzahl
            <input
              value={printedStart}
              onChange={(e) => setPrintedStart(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button className="btn" onClick={buildProposal}>
            Vorschlag erzeugen
          </button>
        </div>

        {pages && (
          <>
            <p className="hint">
              {pages.length} Seiten. Reihenfolge und Rollen bitte prüfen, dann
              speichern.
            </p>
            <ol className="page-order">
              {pages.slice(0, 8).map((p, i) => (
                <li key={i}>
                  {i + 1}. {p.role} · Quelle S.{p.sourcePageIndex + 1}
                  {p.sourceHalf ? (p.sourceHalf === "left" ? " links" : " rechts") : ""} ·{" "}
                  {p.printedLabel ?? "—"}
                  <span className="row">
                    <button className="btn quiet small" onClick={() => move(i, -1)}>
                      Hoch
                    </button>
                    <button className="btn quiet small" onClick={() => move(i, 1)}>
                      Runter
                    </button>
                  </span>
                </li>
              ))}
              {pages.length > 8 && (
                <li className="hint">
                  … {pages.length - 8} weitere Seiten (Innenteil in Dateireihenfolge),
                  zuletzt {pages[pages.length - 1].role}
                </li>
              )}
            </ol>
            <button
              className="btn"
              disabled={busy !== null}
              aria-busy={busy !== null}
              onClick={async () => {
                setErr(null);
                try {
                  const n = await setOrder({ issueId, pages });
                  setMsg(`${n} Seiten gespeichert`);
                } catch (e: any) {
                  setErr(cleanError(e));
                }
              }}
            >
              Reihenfolge speichern
            </button>
          </>
        )}
      </section>

      <section>
        <h4>3. Aufbereitung starten</h4>
        <p className="hint">
          {existingPages?.length ?? 0} Seiten hinterlegt. Der Auftrag rendert die
          Seiten, liest den Text und legt Artikelentwürfe an.
        </p>
        <p className="hint">
          Ein erneuter Lauf ersetzt alle abgeleiteten Daten in einem Zug —
          einschließlich redaktioneller Korrekturen. Bei einer veröffentlichten
          Ausgabe bleiben die Seiten sichtbar, die Artikel stehen danach wieder
          auf offen und müssen neu entschieden werden.
        </p>
        <button
          className="btn"
          disabled={busy !== null || (existingPages?.length ?? 0) === 0}
          aria-busy={busy !== null}
          onClick={async () => {
            setErr(null);
            try {
              await enqueue({ issueId, kind: "full" });
              setMsg("Auftrag eingestellt. Der Worker übernimmt ihn in Kürze.");
            } catch (e: any) {
              setErr(cleanError(e) ?? "Fehler");
            }
          }}
        >
          Import starten
        </button>
      </section>

      {busy && <div className="hint">{busy}...</div>}
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
