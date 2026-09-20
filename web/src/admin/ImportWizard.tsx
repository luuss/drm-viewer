import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, type Id } from "../lib/api";

type PageDraft = {
  sourceAssetId: Id<"assets">;
  sourcePageIndex: number;
  role: "front_cover" | "inside_front" | "content" | "inside_back" | "back_cover" | "other";
  printedLabel?: string;
};

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
  const registerUpload = useMutation(api.assets.registerUpload);
  const addSource = useMutation(api.issueSources.add);
  const sources = useQuery(api.issueSources.listForIssue, { issueId });
  const setOrder = useMutation(api.issuePages.setOrder);
  const enqueue = useMutation(api.imports.enqueue);
  const existingPages = useQuery(api.issuePages.listForEditors, { issueId });

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pages, setPages] = useState<PageDraft[] | null>(null);
  const [printedStart, setPrintedStart] = useState("3");
  const [coverPrintOrder, setCoverPrintOrder] = useState(true);

  async function upload(
    file: File,
    kind: SourceDraft["kind"],
    role: SourceDraft["role"],
  ) {
    setErr(null);
    setBusy(`Lade ${file.name}`);
    try {
      const url = await generateUploadUrl();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error("Upload abgelehnt");
      const { storageId } = await res.json();
      const assetId = await registerUpload({
        storageId,
        key: `uploads/${issueId}/${file.name}`,
        contentType: file.type || "application/octet-stream",
        kind: "source",
        issueId,
        bytes: file.size,
      });
      await addSource({ issueId, assetId, kind, role, filename: file.name });
      setMsg(`${file.name} hochgeladen`);
    } catch (e: any) {
      setErr(e?.message ?? "Upload fehlgeschlagen");
    } finally {
      setBusy(null);
    }
  }

  function buildProposal() {
    const list = (sources ?? []).filter((s: any) => s.kind === "pdf").map((s: any) => ({...s, pageCount: s.pageCount ?? 0}));
    const cover = list.find((s: any) => s.role === "cover");
    const inner = list.find((s: any) => s.role === "inner") ?? list[0];
    if (!inner) {
      setErr("Mindestens ein Innenteil-PDF wird gebraucht");
      return;
    }
    const draft: PageDraft[] = [];
    const start = Number(printedStart) || 1;

    if (cover && cover.pageCount === 4 && coverPrintOrder) {
      // Bogenreihenfolge U4, U1, U2, U3 -> Lesereihenfolge.
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 1, role: "front_cover", printedLabel: "U1" });
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 2, role: "inside_front", printedLabel: "U2" });
    } else if (cover) {
      cover.pageCount >= 1 &&
        draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, role: "front_cover", printedLabel: "U1" });
    }

    for (let i = 0; i < inner.pageCount; i++) {
      draft.push({
        sourceAssetId: inner.assetId,
        sourcePageIndex: i,
        role: "content",
        printedLabel: String(start + i),
      });
    }

    if (cover && cover.pageCount === 4 && coverPrintOrder) {
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 3, role: "inside_back", printedLabel: "U3" });
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, role: "back_cover", printedLabel: "U4" });
    } else if (cover && cover.pageCount > 1) {
      draft.push({
        sourceAssetId: cover.assetId,
        sourcePageIndex: cover.pageCount - 1,
        role: "back_cover",
        printedLabel: "U4",
      });
    }
    setPages(draft);
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
        Eine .indd-Datei wird nur archiviert. Für die automatische Auswertung in
        InDesign bitte zusätzlich als IDML exportieren (Datei → Exportieren →
        InDesign Markup).
      </p>
      <ul className="plain">
        {sources?.map((s: any) => (
          <li key={s._id}>
            {s.filename} · {s.kind} · {s.role} · {s.pageCount ?? "?"} Seiten
          </li>
        ))}
        {sources?.length === 0 && <li className="hint">Noch keine Quelle.</li>}
      </ul>

      <h4>2. Leserreihenfolge</h4>
      <div className="inline-form">
        <label className="consent">
          <input
            type="checkbox"
            checked={coverPrintOrder}
            onChange={(e) => setCoverPrintOrder(e.target.checked)}
          />
          <span>Umschlag liegt in Bogenreihenfolge vor (U4, U1, U2, U3)</span>
        </label>
        <label>
          Erste Innenseite trägt Seitenzahl
          <input
            value={printedStart}
            onChange={(e) => setPrintedStart(e.target.value)}
            size={4}
          />
        </label>
        <button className="btn secondary" onClick={buildProposal}>
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
                {i + 1}. {p.role} · Quelle S.{p.sourcePageIndex + 1} ·{" "}
                {p.printedLabel ?? "—"}
                <button className="link-btn" onClick={() => move(i, -1)}>
                  hoch
                </button>
                <button className="link-btn" onClick={() => move(i, 1)}>
                  runter
                </button>
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
            onClick={async () => {
              setErr(null);
              try {
                const n = await setOrder({ issueId, pages });
                setMsg(`${n} Seiten gespeichert`);
              } catch (e: any) {
                setErr(e?.message ?? "Speichern fehlgeschlagen");
              }
            }}
          >
            Reihenfolge speichern
          </button>
        </>
      )}

      <h4>3. Aufbereitung starten</h4>
      <p className="hint">
        {existingPages?.length ?? 0} Seiten hinterlegt. Der Auftrag rendert die
        Seiten, liest den Text und legt Artikelentwürfe an. Ein erneuter Lauf
        ersetzt alle abgeleiteten Daten in einem Zug.
      </p>
      <button
        className="btn"
        disabled={busy !== null || (existingPages?.length ?? 0) === 0}
        onClick={async () => {
          setErr(null);
          try {
            await enqueue({ issueId, kind: "full" });
            setMsg("Auftrag eingestellt. Der Worker übernimmt ihn in Kürze.");
          } catch (e: any) {
            setErr(e?.message?.replace(/^\[.*?\]\s*/, "") ?? "Fehler");
          }
        }}
      >
        Import starten
      </button>

      {busy && <div className="hint">{busy}...</div>}
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
