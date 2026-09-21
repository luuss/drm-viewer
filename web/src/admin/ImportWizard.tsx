import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, type Id , cleanError } from "../lib/api";

type PageDraft = {
  sourceAssetId: Id<"assets">;
  sourcePageIndex: number;
  // Nur bei Umschlag-Doppelseiten: welche Haelfte die Leserseite ist.
  sourceHalf?: "left" | "right";
  role: "front_cover" | "inside_front" | "content" | "inside_back" | "back_cover" | "other";
  printedLabel?: string;
};

/**
 * Wie die Umschlagdatei aufgebaut ist.
 * sheets:  vier Einzelseiten in Bogenreihenfolge (U4, U1, U2, U3)
 * spreads: zwei Doppelseiten (U4|U1, U2|U3), gelesen als Haelften
 * reading: Einzelseiten bereits in Leserreihenfolge (U1 ... U4)
 * auto:    nach Seitenzahl der Datei entscheiden (2 -> spreads, 4 -> sheets)
 */
type CoverLayout = "auto" | "sheets" | "spreads" | "reading";

/**
 * Seitenzahl eines PDF ohne Bibliothek bestimmen: zaehlt die Seitenobjekte in
 * der Datei, stueckweise, damit ein 150-MB-Heft nicht am Stueck im Speicher
 * liegt. Bei komprimierten Objektstroemen findet sich nichts; dann bleibt das
 * Feld leer und die Redaktion traegt die Zahl selbst ein.
 */
async function countPdfPages(file: File): Promise<number | undefined> {
  const pattern = /\/Type\s*\/Page(?![s\w])/g;
  const chunkBytes = 8 * 1024 * 1024;
  const decoder = new TextDecoder("latin1");
  let count = 0;
  let tail = "";
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const bytes = await file.slice(offset, offset + chunkBytes).arrayBuffer();
      const text = tail + decoder.decode(bytes);
      count += text.match(pattern)?.length ?? 0;
      // Ein Treffer am Stueckrand darf weder verloren gehen noch doppelt zaehlen.
      const carry = text.slice(-24);
      count -= carry.match(pattern)?.length ?? 0;
      tail = carry;
    }
    count += tail.match(pattern)?.length ?? 0;
  } catch {
    return undefined;
  }
  return count > 0 ? count : undefined;
}

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
      const contentType = file.type || "application/octet-stream";
      // Ist ein Medienspeicher eingerichtet, geht die Datei direkt dorthin —
      // grosse Hefte laufen dann nicht durch den Server.
      const direct = await presignUpload({
        issueId,
        filename: file.name,
        contentType,
        bytes: file.size,
      });

      let assetId;
      if (direct) {
        const put = await fetch(direct.url, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: file,
        });
        if (!put.ok) throw new Error("Direkter Upload abgelehnt");
        assetId = await registerUpload({
          bucket: "emag-media",
          key: direct.key,
          contentType,
          kind: "source",
          issueId,
          bytes: file.size,
          filename: file.name,
        });
      } else {
        const url = await generateUploadUrl();
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: file,
        });
        if (!res.ok) throw new Error("Upload abgelehnt");
        const { storageId } = await res.json();
        assetId = await registerUpload({
          storageId,
          key: `uploads/${issueId}/${file.name}`,
          contentType,
          kind: "source",
          issueId,
          bytes: file.size,
          filename: file.name,
        });
      }
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
    const list = (sources ?? []).filter((s: any) => s.kind === "pdf").map((s: any) => ({...s, pageCount: s.pageCount ?? 0}));
    const cover = list.find((s: any) => s.role === "cover");
    const inner = list.find((s: any) => s.role === "inner") ?? list[0];
    if (!inner) {
      setErr("Mindestens ein Innenteil-PDF wird gebraucht");
      return;
    }
    const draft: PageDraft[] = [];
    const start = Number(printedStart) || 1;
    const layout: CoverLayout =
      coverLayout !== "auto"
        ? coverLayout
        : cover?.pageCount === 2
          ? "spreads"
          : cover?.pageCount === 4
            ? "sheets"
            : "reading";
    const spreads = !!cover && layout === "spreads" && cover.pageCount >= 2;
    const sheets = !!cover && layout === "sheets" && cover.pageCount === 4;

    if (cover && spreads) {
      // Erster Bogen: links U4, rechts U1. Zweiter Bogen: links U2, rechts U3.
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, sourceHalf: "right", role: "front_cover", printedLabel: "U1" });
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 1, sourceHalf: "left", role: "inside_front", printedLabel: "U2" });
    } else if (cover && sheets) {
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

    if (cover && spreads) {
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 1, sourceHalf: "right", role: "inside_back", printedLabel: "U3" });
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, sourceHalf: "left", role: "back_cover", printedLabel: "U4" });
    } else if (cover && sheets) {
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
