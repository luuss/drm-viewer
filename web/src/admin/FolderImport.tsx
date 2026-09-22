import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api, cleanError, type Id } from "../lib/api";
import {
  classifyFolder,
  formatBytes,
  fortschrittProzent,
  issueTitleFor,
  parseFolderName,
  type FolderPlan,
  type ImportPhase,
  type ParsedName,
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

type Fortschritt = { text: string; prozent: number };

/** Was der Lauf offen laesst und von Hand nachgetragen werden muss. */
type Ergebnis = {
  ordnerBytes: number;
  hochgeladenBytes: number;
  bilder: number;
  offen: string[];
};

/** Der Ordner mit einer laufenden Nummer: sie stoesst den Lauf an. */
type Eingelesen = { id: number; folderName: string; files: ScannedFile[] };

type Heftname = ParsedName & { bekannt: boolean };

/** Der Benutzer hat abgebrochen — kein Fehler, nur ein Ende. */
class Abgebrochen extends Error {}

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

  const [ordner, setOrdner] = useState<Eingelesen | null>(null);
  const [ueber, setUeber] = useState(false);
  const [mitBildern, setMitBildern] = useState(true);
  const [startNummer, setStartNummer] = useState("3");
  const [sofortImport, setSofortImport] = useState(true);
  const [lauf, setLauf] = useState<Fortschritt | null>(null);
  const [aktiv, setAktiv] = useState(false);
  const [protokoll, setProtokoll] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const feld = useRef<HTMLInputElement>(null);
  /** Der Ordner, fuer den schon ein Lauf angestossen wurde. */
  const gestartet = useRef(0);
  const naechsteId = useRef(0);
  const abbrechen = useRef(false);

  const laeuft = aktiv;

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
  const name: Heftname | null = useMemo(() => {
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

  // Der Ordner allein stoesst den Lauf an: fallen lassen genuegt, ein Knopf
  // steht nicht mehr dazwischen. Gewartet wird nur auf die Reihen — erst mit
  // ihnen steht fest, unter welchem Namen das Heft angelegt wird.
  useEffect(() => {
    if (!ordner || publications === undefined) return;
    if (gestartet.current === ordner.id) return;
    if (!plan || !name) return;
    gestartet.current = ordner.id;
    if (!plan.inner) {
      setErr(
        "Kein Innenteil-PDF im Ordner. Ohne den Innenteil laesst sich nichts importieren.",
      );
      return;
    }
    void starten(plan, name);
    // Angestossen wird allein von einem neuen Ordner; `gestartet` haelt jeden
    // weiteren Durchlauf dieses Effekts ab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordner, plan, name, publications]);

  function notiere(zeile: string) {
    setProtokoll((alt) => [...alt, zeile]);
  }

  function uebernehmen(gelesen: Awaited<ReturnType<typeof readDroppedFolder>>) {
    if (laeuft) return;
    if (!gelesen) {
      setErr("Das war kein Ordner. Bitte den ganzen Heftordner fallen lassen.");
      return;
    }
    setErr(null);
    setErgebnis(null);
    setProtokoll([]);
    setLauf(null);
    abbrechen.current = false;
    setOrdner({ id: ++naechsteId.current, ...gelesen });
  }

  async function starten(plan: FolderPlan, name: Heftname) {
    if (!plan.inner) return;
    const innenteil = plan.inner;
    setErr(null);
    setErgebnis(null);
    setProtokoll([]);
    setAktiv(true);
    abbrechen.current = false;

    // Erledigte Abschnitte. Was dieser Ordner nicht hat, gilt sofort als
    // erledigt — sonst bliebe der Balken am Ende stehen.
    const erledigt: ImportPhase[] = [];
    const offen: string[] = [];
    let hochgeladen = 0;
    let bilder = 0;

    function melde(phase: ImportPhase, text: string, anteil = 0) {
      setLauf({ text, prozent: fortschrittProzent(erledigt, phase, anteil) });
    }
    function abhaken(phase: ImportPhase) {
      erledigt.push(phase);
    }
    function pruefen() {
      if (abbrechen.current) throw new Abgebrochen();
    }

    const wandler = new ImageConverter();
    try {
      // 1. Heft anlegen oder wiederfinden.
      melde("heft", "Heft anlegen");
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
      if (heft.created) offen.push("Preis eintragen — ein neues Heft steht auf 0,00 €");
      onIssue?.(issueId);
      abhaken("heft");
      pruefen();

      const deps = { presignUpload, registerUpload, generateUploadUrl };

      // 2. Innenteil und Umschlag als PDF — unveraendert, sie sind die Vorlage
      //    fuer die gerenderten Seiten. Der Innenteil ist die eine Datei, ohne
      //    die der Lauf keinen Sinn hat: scheitert er, bricht alles ab.
      melde(
        "innenteil",
        `Innenteil ${innenteil.name} (${formatBytes(innenteil.size)}) geht hoch`,
      );
      let innerAsset: Id<"assets">;
      let innerSeiten: number | undefined;
      try {
        innerAsset = await uploadAsset(deps, issueId, innenteil.file, innenteil.name);
        innerSeiten = await countPdfPages(innenteil.file);
        await addSource({
          issueId,
          assetId: innerAsset,
          kind: "pdf",
          role: "inner",
          filename: innenteil.name,
          pageCount: innerSeiten,
        });
      } catch (e: any) {
        if (e instanceof Abgebrochen) throw e;
        throw new Error(
          `Innenteil ${innenteil.name} liess sich nicht hochladen: ` +
            `${cleanError(e) ?? "Fehler"}. Der Lauf ist abgebrochen.`,
        );
      }
      hochgeladen += innenteil.size;
      notiere(
        `Innenteil ${innenteil.name} (${formatBytes(innenteil.size)}` +
          `${innerSeiten ? `, ${innerSeiten} Seiten` : ""})`,
      );
      if (!innerSeiten) {
        offen.push(
          "Seitenzahl des Innenteils war nicht lesbar — Reihenfolge im Importdialog erzeugen",
        );
      }
      abhaken("innenteil");
      pruefen();

      let coverPdf: { assetId: Id<"assets">; pageCount: number } | undefined;
      if (plan.cover) {
        const umschlag = plan.cover;
        melde("umschlag", `Umschlag ${umschlag.name} geht hoch`);
        try {
          const assetId = await uploadAsset(deps, issueId, umschlag.file, umschlag.name);
          const seiten = await countPdfPages(umschlag.file);
          await addSource({
            issueId,
            assetId,
            kind: "pdf",
            role: "cover",
            filename: umschlag.name,
            pageCount: seiten,
          });
          coverPdf = { assetId, pageCount: seiten ?? 1 };
          hochgeladen += umschlag.size;
          notiere(`Umschlag ${umschlag.name} (${formatBytes(umschlag.size)})`);
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(
            `Umschlag ${umschlag.name} nachtragen — ${cleanError(e) ?? "nicht hochgeladen"}`,
          );
        }
      }
      abhaken("umschlag");
      pruefen();

      // 3. Satzdatei.
      if (plan.idml) {
        const satz = plan.idml;
        melde("satzdatei", `Satzdatei ${satz.name} geht hoch`);
        try {
          const assetId = await uploadAsset(deps, issueId, satz.file, satz.name);
          await addSource({
            issueId,
            assetId,
            kind: "idml",
            role: "supplemental",
            filename: satz.name,
          });
          hochgeladen += satz.size;
          notiere(`Satzdatei ${satz.name} (${formatBytes(satz.size)})`);
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(
            `Satzdatei ${satz.name} nachtragen — ${cleanError(e) ?? "nicht hochgeladen"}`,
          );
        }
      } else {
        offen.push(
          "Keine Satzdatei (IDML) im Ordner — die Artikelerkennung bleibt ungenau",
        );
      }
      abhaken("satzdatei");
      pruefen();

      // 4. Titelseite: im Browser aus der TIF in ein JPEG umwandeln.
      let coverImageAsset: Id<"assets"> | undefined;
      if (!plan.cover && plan.coverImage) {
        const titel = plan.coverImage;
        melde("titelseite", `Titelseite ${titel.name} wird umgewandelt`);
        try {
          const bild = await wandler.convert(
            titel.file,
            titel.name,
            TITEL_KANTE,
            0.88,
          );
          const dateiname = jpegName(titel.name);
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
          hochgeladen += bild.blob.size;
          notiere(
            `Titelseite ${titel.name}: ${bild.sourceWidth}×${bild.sourceHeight} ` +
              `→ ${bild.width}×${bild.height}, ${formatBytes(titel.size)} → ` +
              formatBytes(bild.blob.size),
          );
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(
            `Titelseite ${titel.name} nachtragen — ${cleanError(e) ?? "nicht lesbar"}`,
          );
        }
      } else if (!plan.cover && !plan.coverImage) {
        offen.push("Weder Umschlag-PDF noch Titelseite im Ordner — Titelbild nachtragen");
      }
      abhaken("titelseite");
      pruefen();

      // 5. Platzierte Bilder. Sie machen den Ordner gross und gehen nur
      //    verkleinert hoch; was sich nicht lesen laesst, wird uebergangen.
      //    Ein einzelnes Bild haelt den Lauf nie an.
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
          pruefen();
          const datei = plan.artwork[i];
          melde("bilder", `Bild ${i + 1} von ${gesamt}: ${datei.name}`, i / gesamt);
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
            if (e instanceof Abgebrochen) throw e;
            uebergangen++;
            const grund = cleanError(e) ?? "nicht lesbar";
            notiere(`Bild übergangen: ${datei.name} (${grund})`);
            offen.push(`Bild ${datei.name} nachtragen — ${grund}`);
          }
        }
        melde("bilder", `${eintraege.length} Bilder eintragen`, 1);
        for (let i = 0; i < eintraege.length; i += 40) {
          await addArtwork({ issueId, items: eintraege.slice(i, i + 40) });
        }
        hochgeladen += nachher;
        bilder = eintraege.length;
        notiere(
          `${eintraege.length} Bilder umgewandelt: ${formatBytes(vorher)} → ` +
            `${formatBytes(nachher)}${uebergangen ? `, ${uebergangen} übergangen` : ""}`,
        );
      } else if (plan.artwork.length) {
        offen.push(
          `${plan.artwork.length} Bilder aus Links/ wurden nicht umgewandelt ` +
            "— die Einstellung dafür war aus",
        );
      }
      abhaken("bilder");
      pruefen();

      // 6. Leserreihenfolge.
      if (innerSeiten) {
        melde("reihenfolge", "Seitenreihenfolge speichern");
        try {
          const seiten = buildPageOrder<Id<"assets">>({
            inner: { assetId: innerAsset, pageCount: innerSeiten },
            cover: coverPdf,
            coverImageAssetId: coverImageAsset,
            printedStart: Number(startNummer) || 3,
          });
          const n = await setOrder({ issueId, pages: seiten });
          notiere(`${n} Seiten in Leserreihenfolge`);
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(
            `Seitenreihenfolge im Importdialog erzeugen — ${cleanError(e) ?? "Fehler"}`,
          );
        }
      }
      abhaken("reihenfolge");
      pruefen();

      // 7. Aufbereitung.
      if (sofortImport && innerSeiten) {
        melde("aufbereitung", "Aufbereitung einstellen");
        try {
          await enqueue({ issueId, kind: "full" });
          notiere("Aufbereitung eingestellt");
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(`Aufbereitung von Hand starten — ${cleanError(e) ?? "Fehler"}`);
        }
      } else {
        offen.push("Aufbereitung ist noch nicht eingestellt — im Importdialog starten");
      }
      abhaken("aufbereitung");

      setLauf({ text: "Fertig", prozent: 100 });
      setErgebnis({
        ordnerBytes: plan.totalBytes,
        hochgeladenBytes: hochgeladen,
        bilder,
        offen,
      });
    } catch (e: any) {
      if (e instanceof Abgebrochen) {
        setErr("Abgebrochen. Was bis dahin hochging, steht schon am Heft.");
      } else {
        setErr(cleanError(e) ?? "Fehler");
      }
    } finally {
      // Der Balken bleibt stehen, wo der Lauf endete: bei hundert Prozent
      // oder an der Stelle, an der abgebrochen wurde.
      wandler.dispose();
      setAktiv(false);
      abbrechen.current = false;
    }
  }

  const uebergangen = plan ? plan.totalBytes - plan.uploadBytes : 0;

  return (
    <div className="folder-import">
      <div
        className={`dropzone${ueber ? " over" : ""}${laeuft ? " busy" : ""}`}
        onDragOver={(e) => {
          if (laeuft) return;
          e.preventDefault();
          setUeber(true);
        }}
        onDragLeave={() => setUeber(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setUeber(false);
          if (laeuft) return;
          try {
            uebernehmen(await readDroppedFolder(e.dataTransfer.items));
          } catch (ex: any) {
            setErr(`Ordner liess sich nicht lesen: ${ex?.message ?? ex}`);
          }
        }}
        onClick={() => {
          if (!laeuft) feld.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-disabled={laeuft}
        onKeyDown={(e) => {
          if (!laeuft && (e.key === "Enter" || e.key === " ")) feld.current?.click();
        }}
      >
        <strong>
          {laeuft ? "Import läuft — bitte warten" : "Heftordner hierher ziehen"}
        </strong>
        <span className="hint">
          {laeuft
            ? "Der nächste Ordner kann gleich danach fallen gelassen werden."
            : "Der Ordner wird gelesen und sofort importiert: Innenteil, Titelseite, Satzdatei und die Bilder aus Links/. Bilder wandelt der Browser um; die Originale bleiben hier."}
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
            e.target.value = "";
          }}
        />
      </div>

      {/* Die Einstellungen gelten fuer den naechsten Ordner: gelesen werden sie
          in dem Augenblick, in dem der Lauf anfaengt. */}
      <div className="import-optionen">
        <label className="narrow-field">
          Erste Innenseite trägt Seitenzahl
          <input
            value={startNummer}
            inputMode="numeric"
            disabled={laeuft}
            onChange={(e) => setStartNummer(e.target.value)}
          />
        </label>
        <label className="muted">
          <input
            type="checkbox"
            checked={mitBildern}
            disabled={laeuft}
            onChange={(e) => setMitBildern(e.target.checked)}
          />{" "}
          Bilder aus Links/ umwandeln
        </label>
        <label className="muted">
          <input
            type="checkbox"
            checked={sofortImport}
            disabled={laeuft}
            onChange={(e) => setSofortImport(e.target.checked)}
          />{" "}
          Aufbereitung gleich starten
        </label>
      </div>

      {lauf && (
        <div className="lauf" role="status" aria-live="polite">
          <div className="lauf-kopf">
            <span>{lauf.text}</span>
            <span className="lauf-wert">{lauf.prozent} %</span>
          </div>
          <progress className="lauf-balken" max={100} value={lauf.prozent}>
            {lauf.prozent} %
          </progress>
          {aktiv && (
            <button
              type="button"
              className="btn secondary small"
              onClick={() => {
                abbrechen.current = true;
              }}
            >
              Abbrechen
            </button>
          )}
        </div>
      )}

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
        </div>
      )}

      {protokoll.length > 0 && (
        <ul className="source-list">
          {protokoll.map((z, i) => (
            <li key={i}>{z}</li>
          ))}
        </ul>
      )}

      {ergebnis && (
        <div className="lauf-ergebnis">
          <div className="ok">Fertig. Das Heft ist hochgeladen und importiert.</div>
          <p className="hint">
            Ordner {formatBytes(ergebnis.ordnerBytes)} · hochgeladen{" "}
            {formatBytes(ergebnis.hochgeladenBytes)} · {ergebnis.bilder} Bilder
          </p>
          <h5>Nachzutragen</h5>
          {ergebnis.offen.length > 0 ? (
            <ul className="nachtrag">
              {ergebnis.offen.map((z, i) => (
                <li key={i}>{z}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">Nichts offen — es hat alles geklappt.</p>
          )}
        </div>
      )}

      {err && <div className="err">{err}</div>}
    </div>
  );
}
