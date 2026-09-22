import { useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, cleanError, type Id } from "../lib/api";
import {
  classifyFolder,
  formatBytes,
  issueTitleFor,
  parseFolderName,
  type FolderPlan,
  type ScannedFile,
} from "./folderScan";
import { readDirectoryInput, readDroppedFolder } from "./folderDrop";
import { ImageConverter } from "./convertClient";
import { jpegName } from "./imageConvert";
import { buildPageOrder } from "./pageOrder";
import { countPdfPages, uploadAsset } from "./uploadAsset";

/** Laengste Kante der umgewandelten Bilder. */
const ARTWORK_KANTE = 1600;
const ARTWORK_GUETE = 0.82;
/** Titelseiten werden im Reader ganzseitig gezeigt und bleiben groesser. */
const TITEL_KANTE = 2400;

type Fortschritt = { text: string; getan: number; gesamt: number };

export default function FolderImport({
  onIssue,
}: {
  onIssue?: (issueId: Id<"issues">) => void;
}) {
  const publications = useQuery(api.publications.listAll, {});
  const ensureIssue = useMutation(api.issues.ensureFromFolder);
  const presignUpload = useAction(api.uploads.presignUpload);
  const registerUpload = useMutation(api.assets.registerUpload);
  const generateUploadUrl = useMutation(api.assets.generateUploadUrl);
  const addSource = useMutation(api.issueSources.add);
  const addArtwork = useMutation(api.issueSources.addArtwork);
  const setOrder = useMutation(api.issuePages.setOrder);
  const enqueue = useMutation(api.imports.enqueue);

  const [ordner, setOrdner] = useState<{
    folderName: string;
    files: ScannedFile[];
  } | null>(null);
  const [ueber, setUeber] = useState(false);
  const [mitBildern, setMitBildern] = useState(true);
  const [startNummer, setStartNummer] = useState("3");
  const [sofortImport, setSofortImport] = useState(true);
  const [lauf, setLauf] = useState<Fortschritt | null>(null);
  const [protokoll, setProtokoll] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [fertig, setFertig] = useState<string | null>(null);
  const feld = useRef<HTMLInputElement>(null);

  const plan: FolderPlan | null = useMemo(
    () => (ordner ? classifyFolder(ordner.folderName, ordner.files) : null),
    [ordner],
  );
  const gelesen = useMemo(
    () => (ordner ? parseFolderName(ordner.folderName) : null),
    [ordner],
  );
  // Eine schon gepflegte Reihe steht unter ihrem Namen, nicht unter der
  // Abkuerzung aus dem Ordnernamen: "dmz" ist die Deutsche Militaerzeitschrift.
  const name = useMemo(() => {
    if (!gelesen) return null;
    const bekannt = publications?.find((p) => p.slug === gelesen.publicationSlug);
    const publicationName = bekannt?.name ?? gelesen.publicationName;
    return {
      ...gelesen,
      publicationName,
      issueTitle: issueTitleFor(gelesen, publicationName),
      bekannt: !!bekannt,
    };
  }, [gelesen, publications]);

  function notiere(zeile: string) {
    setProtokoll((alt) => [...alt, zeile]);
  }

  async function uebernehmen(gelesen: Awaited<ReturnType<typeof readDroppedFolder>>) {
    if (!gelesen) {
      setErr("Das war kein Ordner. Bitte den ganzen Heftordner fallen lassen.");
      return;
    }
    setErr(null);
    setFertig(null);
    setProtokoll([]);
    setOrdner(gelesen);
  }

  async function starten() {
    if (!plan || !name || !plan.inner) return;
    setErr(null);
    setFertig(null);
    setProtokoll([]);
    const wandler = new ImageConverter();
    try {
      // 1. Heft anlegen oder wiederfinden.
      setLauf({ text: "Heft anlegen", getan: 0, gesamt: 1 });
      const heft = await ensureIssue({
        publicationSlug: name.publicationSlug,
        publicationName: name.publicationName,
        title: name.issueTitle,
        issueNumber: name.issueNumber,
      });
      const issueId = heft.issueId;
      notiere(
        heft.created
          ? `Heft „${name.issueTitle}" angelegt`
          : `Heft „${name.issueTitle}" war schon da — die Quellen werden ersetzt`,
      );
      if (heft.publicationCreated) notiere(`Reihe „${name.publicationName}" angelegt`);
      onIssue?.(issueId);

      const deps = { presignUpload, registerUpload, generateUploadUrl };

      // 2. Innenteil und Umschlag als PDF — unveraendert, sie sind die Vorlage
      //    fuer die gerenderten Seiten.
      setLauf({ text: `Innenteil ${plan.inner.name}`, getan: 0, gesamt: 1 });
      const innerAsset = await uploadAsset(deps, issueId, plan.inner.file, plan.inner.name);
      const innerSeiten = await countPdfPages(plan.inner.file);
      await addSource({
        issueId,
        assetId: innerAsset,
        kind: "pdf",
        role: "inner",
        filename: plan.inner.name,
        pageCount: innerSeiten,
      });
      notiere(
        `Innenteil ${plan.inner.name} (${formatBytes(plan.inner.size)}` +
          `${innerSeiten ? `, ${innerSeiten} Seiten` : ""})`,
      );

      let coverPdf: { assetId: Id<"assets">; pageCount: number } | undefined;
      if (plan.cover) {
        setLauf({ text: `Umschlag ${plan.cover.name}`, getan: 0, gesamt: 1 });
        const assetId = await uploadAsset(deps, issueId, plan.cover.file, plan.cover.name);
        const seiten = await countPdfPages(plan.cover.file);
        await addSource({
          issueId,
          assetId,
          kind: "pdf",
          role: "cover",
          filename: plan.cover.name,
          pageCount: seiten,
        });
        coverPdf = { assetId, pageCount: seiten ?? 1 };
        notiere(`Umschlag ${plan.cover.name} (${formatBytes(plan.cover.size)})`);
      }

      // 3. Satzdatei.
      if (plan.idml) {
        setLauf({ text: `Satzdatei ${plan.idml.name}`, getan: 0, gesamt: 1 });
        const assetId = await uploadAsset(deps, issueId, plan.idml.file, plan.idml.name);
        await addSource({
          issueId,
          assetId,
          kind: "idml",
          role: "supplemental",
          filename: plan.idml.name,
        });
        notiere(`Satzdatei ${plan.idml.name} (${formatBytes(plan.idml.size)})`);
      }

      // 4. Titelseite: im Browser aus der TIF in ein JPEG umwandeln.
      let coverImageAsset: Id<"assets"> | undefined;
      if (!plan.cover && plan.coverImage) {
        setLauf({ text: `Titelseite ${plan.coverImage.name}`, getan: 0, gesamt: 1 });
        const bild = await wandler.convert(
          plan.coverImage.file,
          plan.coverImage.name,
          TITEL_KANTE,
          0.88,
        );
        const dateiname = jpegName(plan.coverImage.name);
        coverImageAsset = await uploadAsset(
          deps,
          issueId,
          bild.blob,
          dateiname,
          "source",
        );
        await addSource({
          issueId,
          assetId: coverImageAsset,
          kind: "image",
          role: "cover",
          filename: dateiname,
          pageCount: 1,
          width: bild.width,
          height: bild.height,
          sourceWidth: bild.sourceWidth,
          sourceHeight: bild.sourceHeight,
        });
        notiere(
          `Titelseite ${plan.coverImage.name}: ${bild.sourceWidth}×${bild.sourceHeight} ` +
            `→ ${bild.width}×${bild.height}, ${formatBytes(plan.coverImage.size)} → ` +
            formatBytes(bild.blob.size),
        );
      }

      // 5. Platzierte Bilder. Sie machen den Ordner gross und gehen nur
      //    verkleinert hoch; was sich nicht lesen laesst, wird uebergangen.
      if (mitBildern && plan.artwork.length) {
        const gesamt = plan.artwork.length;
        let vorher = 0;
        let nachher = 0;
        let uebergangen = 0;
        const eintraege: {
          assetId: Id<"assets">;
          filename: string;
          width: number;
          height: number;
          sourceWidth: number;
          sourceHeight: number;
        }[] = [];
        for (let i = 0; i < gesamt; i++) {
          const datei = plan.artwork[i];
          setLauf({ text: `Bild ${datei.name}`, getan: i, gesamt });
          try {
            const bild = await wandler.convert(
              datei.file,
              datei.name,
              ARTWORK_KANTE,
              ARTWORK_GUETE,
            );
            const assetId = await uploadAsset(
              deps,
              issueId,
              bild.blob,
              jpegName(datei.name),
              "image",
            );
            eintraege.push({
              assetId,
              // Der Name aus `Links/` bleibt stehen: unter ihm nennt die
              // Satzdatei das Bild, darueber findet der Worker es wieder.
              filename: datei.name,
              width: bild.width,
              height: bild.height,
              sourceWidth: bild.sourceWidth,
              sourceHeight: bild.sourceHeight,
            });
            vorher += datei.size;
            nachher += bild.blob.size;
          } catch (e: any) {
            uebergangen++;
            notiere(`Bild übergangen: ${datei.name} (${e?.message ?? "nicht lesbar"})`);
          }
        }
        for (let i = 0; i < eintraege.length; i += 40) {
          await addArtwork({ issueId, items: eintraege.slice(i, i + 40) });
        }
        notiere(
          `${eintraege.length} Bilder umgewandelt: ${formatBytes(vorher)} → ` +
            `${formatBytes(nachher)}${uebergangen ? `, ${uebergangen} übergangen` : ""}`,
        );
      }

      // 6. Leserreihenfolge.
      if (innerSeiten) {
        setLauf({ text: "Seitenreihenfolge speichern", getan: 0, gesamt: 1 });
        const seiten = buildPageOrder<Id<"assets">>({
          inner: { assetId: innerAsset, pageCount: innerSeiten },
          cover: coverPdf,
          coverImageAssetId: coverImageAsset,
          printedStart: Number(startNummer) || 3,
        });
        const n = await setOrder({ issueId, pages: seiten });
        notiere(`${n} Seiten in Leserreihenfolge`);
      } else {
        notiere(
          "Seitenzahl des Innenteils nicht lesbar — Reihenfolge bitte im Importdialog erzeugen",
        );
      }

      // 7. Aufbereitung.
      if (sofortImport && innerSeiten) {
        await enqueue({ issueId, kind: "full" });
        notiere("Aufbereitung eingestellt");
      }
      setFertig(
        `Fertig. Vom Ordner (${formatBytes(plan.totalBytes)}) ging nur das Nötige hoch.`,
      );
    } catch (e: any) {
      setErr(cleanError(e) ?? "Fehler");
    } finally {
      wandler.dispose();
      setLauf(null);
    }
  }

  const uebergangen = plan
    ? plan.totalBytes - plan.uploadBytes
    : 0;

  return (
    <div className="folder-import">
      <div
        className={`dropzone${ueber ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setUeber(true);
        }}
        onDragLeave={() => setUeber(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setUeber(false);
          try {
            await uebernehmen(await readDroppedFolder(e.dataTransfer.items));
          } catch (ex: any) {
            setErr(`Ordner liess sich nicht lesen: ${ex?.message ?? ex}`);
          }
        }}
        onClick={() => feld.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") feld.current?.click();
        }}
      >
        <strong>Heftordner hierher ziehen</strong>
        <span className="hint">
          Innenteil, Titelseite, Satzdatei und die Bilder aus <code>Links/</code>{" "}
          werden erkannt. Bilder wandelt der Browser um; die Originale bleiben hier.
        </span>
        <input
          ref={feld}
          type="file"
          hidden
          multiple
          // Ohne Drag-and-Drop: Ordner ueber das Dateifeld waehlen.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            if (e.target.files) uebernehmen(readDirectoryInput(e.target.files));
          }}
        />
      </div>

      {plan && name && (
        <div className="plan">
          <h4>{plan.folderName}</h4>
          <p className="hint">
            Reihe <strong>{name.publicationName}</strong>{" "}
            <span className="muted">/{name.publicationSlug}</span>
            {name.issueNumber ? (
              <>
                {" "}· Heft <strong>{name.issueNumber}</strong>
              </>
            ) : null}{" "}
            · Titel <strong>{name.issueTitle}</strong>
          </p>

          <table className="plan-table">
            <tbody>
              <tr>
                <th>Innenteil</th>
                <td>{plan.inner?.name ?? "—"}</td>
                <td className="muted">
                  {plan.inner ? formatBytes(plan.inner.size) : ""}
                </td>
                <td>geht hoch</td>
              </tr>
              <tr>
                <th>Umschlag</th>
                <td>{plan.cover?.name ?? plan.coverImage?.name ?? "—"}</td>
                <td className="muted">
                  {formatBytes(plan.cover?.size ?? plan.coverImage?.size ?? 0)}
                </td>
                <td>{plan.cover ? "geht hoch" : "wird umgewandelt"}</td>
              </tr>
              <tr>
                <th>Satzdatei</th>
                <td>{plan.idml?.name ?? "—"}</td>
                <td className="muted">{formatBytes(plan.idml?.size ?? 0)}</td>
                <td>geht hoch</td>
              </tr>
              <tr>
                <th>Bilder</th>
                <td>{plan.artwork.length} aus Links/</td>
                <td className="muted">
                  {formatBytes(plan.artwork.reduce((n, f) => n + f.size, 0))}
                </td>
                <td>{mitBildern ? "werden umgewandelt" : "bleiben hier"}</td>
              </tr>
              <tr>
                <th>Archiv</th>
                <td>{plan.indd.map((f) => f.name).join(", ") || "—"}</td>
                <td className="muted">
                  {formatBytes(plan.indd.reduce((n, f) => n + f.size, 0))}
                </td>
                <td>bleibt hier</td>
              </tr>
              <tr>
                <th>Übriges</th>
                <td>{plan.ignored.length} Dateien</td>
                <td className="muted">
                  {formatBytes(
                    plan.ignored.reduce((n, e) => n + e.file.size, 0),
                  )}
                </td>
                <td>bleibt hier</td>
              </tr>
            </tbody>
          </table>

          <p className="hint">
            Ordner {formatBytes(plan.totalBytes)} · unverändert hoch{" "}
            {formatBytes(plan.uploadBytes)} · nicht hochgeladen{" "}
            {formatBytes(uebergangen)}
          </p>

          {plan.problems.map((p) => (
            <div className="warn" key={p}>
              {p}
            </div>
          ))}

          <div className="order-row">
            <label className="narrow-field">
              Erste Innenseite trägt Seitenzahl
              <input
                value={startNummer}
                inputMode="numeric"
                onChange={(e) => setStartNummer(e.target.value)}
              />
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={mitBildern}
                onChange={(e) => setMitBildern(e.target.checked)}
              />{" "}
              Bilder aus Links/ umwandeln
            </label>
            <label className="muted">
              <input
                type="checkbox"
                checked={sofortImport}
                onChange={(e) => setSofortImport(e.target.checked)}
              />{" "}
              Aufbereitung gleich starten
            </label>
          </div>

          <button
            className="btn"
            disabled={!plan.inner || lauf !== null}
            aria-busy={lauf !== null}
            onClick={starten}
          >
            Heft anlegen und hochladen
          </button>
        </div>
      )}

      {lauf && (
        <div className="hint">
          {lauf.text}
          {lauf.gesamt > 1 ? ` · ${lauf.getan + 1}/${lauf.gesamt}` : ""}…
        </div>
      )}
      {protokoll.length > 0 && (
        <ul className="source-list">
          {protokoll.map((z, i) => (
            <li key={i}>{z}</li>
          ))}
        </ul>
      )}
      {fertig && <div className="ok">{fertig}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
