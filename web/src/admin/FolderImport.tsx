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
import { FAEDEN, ImageConverter } from "./convertClient";
import { jpegName } from "./imageConvert";
import { Ladeschlange } from "./ladeschlange";
import { buildPageOrder } from "./pageOrder";
import { uploadAsset } from "./uploadAsset";
import { readIdmlMeta } from "./idmlMeta";
import { textebeneAlsBlob, type TextPage } from "./textLayer";
import {
  oeffnePdf,
  RENDER_SPUREN,
  readPriceFromImprint,
  renderPdfPages,
  type OffenesPdf,
  type RenderedPage,
} from "./pageRender";

/** Laengste Kante der umgewandelten Bilder. */
// Wie viele Uploads gleichzeitig laufen duerfen. Vier halten die Leitung
// ausgelastet, ohne dass sich die Blobs im Speicher stapeln.
const GLEICHZEITIGE_UPLOADS = 4;
const ARTWORK_KANTE = 1600;
const ARTWORK_GUETE = 0.82;
/** Titelseiten werden im Reader ganzseitig gezeigt und bleiben groesser. */
const TITEL_KANTE = 2400;
/**
 * Breite der gerenderten Druckseiten. Daraus schneidet das Kachel-Gateway
 * seine Kacheln; das reicht fuer scharfen Zoom auf Magazinseiten.
 */
const SEITEN_BREITE = 2400;
// Mit parallelem Rendern ist die Leitung der Engpass (ZUERST! 3/2026: drei
// Spuren warteten summiert 283 s auf Upload-Plaetze). 0,82 statt 0,86 spart
// rund ein Fuenftel der Bytes; beim Zoomen sieht man keinen Unterschied.
const SEITEN_GUETE = 0.82;

/** `fehler`: der Lauf ist hier stehen geblieben — der Balken zeigt das an. */
type Fortschritt = { text: string; prozent: number; fehler?: boolean };

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

    // Erledigte Abschnitte. Was dieser Ordner nicht hat, zaehlt im Balken gar
    // nicht mit — sonst spraenge er ueber die fehlenden Abschnitte hinweg.
    const erledigt: ImportPhase[] = [];
    const entfallen: ImportPhase[] = [];
    if (!plan.cover) entfallen.push("umschlag");
    if (!plan.idml) entfallen.push("satzdatei");
    if (plan.cover || !plan.coverImage) entfallen.push("titelseite");
    if (!mitBildern || !plan.artwork.length) entfallen.push("bilder");
    if (!sofortImport) entfallen.push("aufbereitung");
    const offen: string[] = [];
    let hochgeladen = 0;
    let bilder = 0;

    function melde(phase: ImportPhase, text: string, anteil = 0) {
      setLauf({ text, prozent: fortschrittProzent(erledigt, phase, anteil, entfallen) });
    }
    function abhaken(phase: ImportPhase) {
      erledigt.push(phase);
    }
    function pruefen() {
      if (abbrechen.current) throw new Abgebrochen();
    }

    const wandler = new ImageConverter();
    let innenPdf: OffenesPdf | null = null;
    try {
      // 1. Heft anlegen oder wiederfinden. Der Einzelpreis steht im Impressum
      //    des Innenteils; er wird hier gelesen, weil die Druckdatei den
      //    Rechner nicht verlaesst. Geoeffnet wird sie dafuer einmal, fuer
      //    Preis und Seiten zusammen.
      melde("heft", `Innenteil ${innenteil.name} wird gelesen`);
      try {
        innenPdf = await oeffnePdf(innenteil.file);
      } catch (e: any) {
        throw new Error(
          `Innenteil ${innenteil.name} laesst sich nicht oeffnen: ` +
            `${cleanError(e) ?? "kein lesbares PDF"}. Der Lauf ist abgebrochen.`,
        );
      }
      melde("heft", "Heft anlegen");
      const preis = await readPriceFromImprint(innenPdf).catch(() => undefined);
      const heft = await ensureIssue({
        publicationSlug: name.publicationSlug,
        publicationName: name.publicationName,
        title: name.issueTitle,
        issueNumber: name.issueNumber,
        priceAmountCents: preis,
      });
      const issueId = heft.issueId;
      notiere(
        heft.created
          ? `Heft „${name.issueTitle}" angelegt`
          : `Heft „${name.issueTitle}" war schon da — die Quellen werden ersetzt`,
      );
      if (heft.publicationCreated) notiere(`Reihe „${name.publicationName}" angelegt`);
      if (preis) {
        notiere(`Einzelpreis aus dem Impressum: ${(preis / 100).toFixed(2)} €`);
      } else if (heft.created) {
        offen.push(
          "Im Impressum stand kein Einzelpreis — die Aufbereitung liest ihn " +
            "von der Titelseite; bitte nachsehen, ob er stimmt",
        );
      }
      onIssue?.(issueId);
      abhaken("heft");
      pruefen();

      const deps = { presignUpload, registerUpload, generateUploadUrl };

      // 2. Innenteil: der Browser rendert die Seiten selbst und laedt nur sie
      //    hoch. Die Druckdatei bleibt hier — sie ist der groesste Posten im
      //    Ordner und wird auf dem Server nur als Bild gebraucht. Geschnitten
      //    wird auf das Netzformat aus der Satzdatei, damit Anschnitt und
      //    Schnittmarken gar nicht erst im Reader landen.
      const satzMass = plan.idml ? await readIdmlMeta(plan.idml.file).catch(() => null) : null;
      // Die gedruckte Zahl der ersten Innenseite steht im Satz. Fehlt sie,
      // gilt 3: Umschlag und Umschlaginnenseite sind die ersten beiden.
      const gedruckteStartseite = satzMass?.firstPrintedPage ?? 3;
      if (plan.idml && !satzMass) {
        offen.push("Netzformat aus der Satzdatei nicht lesbar — Seiten behalten den Anschnitt");
      }
      melde("innenteil", `Innenteil ${innenteil.name} wird gerendert`);
      // Rendern und Hochladen laufen nebeneinander. Ohne das stand abwechselnd
      // der Rechner oder die Leitung still.
      const schlange = new Ladeschlange(GLEICHZEITIGE_UPLOADS);
      const innenSeiten: {
        assetId: Id<"assets">;
        previewKey: string;
        width: number;
        height: number;
      }[] = [];
      let innerSeiten: number | undefined;
      // Wie lange das Rendern auf freie Upload-Plaetze wartete: steht es
      // lange, ist die Leitung der Engpass, nicht der Rechner.
      // Die Textebene jeder Innenseite: Zeilen mit ihren Rechtecken im
      // Netzformat. Der Worker legt damit die Klickflaechen des gedruckten
      // Inhaltsverzeichnisses auf die Eintraege — der Satz allein weiss nicht,
      // wo eine Zeile steht.
      const textebene: TextPage[] = [];
      const innenStart = performance.now();
      let uploadWarten = 0;
      let fertigeSeiten = 0;
      try {
        await renderPdfPages(
          innenPdf,
          {
            targetWidth: SEITEN_BREITE,
            quality: SEITEN_GUETE,
            trimWidthPt: satzMass?.pageWidthPt,
            trimHeightPt: satzMass?.pageHeightPt,
            spuren: RENDER_SPUREN,
            mitText: true,
          },
          async (seite: RenderedPage, i: number, total: number) => {
            pruefen();
            if (seite.text) textebene[i] = { sourcePageIndex: i, items: seite.text };
            fertigeSeiten++;
            melde(
              "innenteil",
              `Seite ${fertigeSeiten} von ${total}: ${innenteil.name}`,
              fertigeSeiten / total,
            );
            const dateiname = `seite-${String(i + 1).padStart(3, "0")}.jpg`;
            // Nicht auf den Upload warten: die naechste Seite kann schon
            // gerendert werden, waehrend diese hochgeht.
            const wartenAb = performance.now();
            await schlange.einreihen(async () => {
              const { assetId, key } = await uploadAsset(
                deps,
                issueId,
                seite.blob,
                dateiname,
                "page",
              );
              innenSeiten[i] = {
                assetId,
                previewKey: key,
                width: seite.width,
                height: seite.height,
              };
              hochgeladen += seite.blob.size;
            });
            uploadWarten += performance.now() - wartenAb;
          },
          () => abbrechen.current,
        );
        const wartenAb = performance.now();
        await schlange.fertig();
        uploadWarten += performance.now() - wartenAb;
        innerSeiten = innenSeiten.length;
      } catch (e: any) {
        // Was noch hochgeht, zu Ende laufen lassen: sonst meldet die Seite
        // das Ende, waehrend im Hintergrund weiter Uploads laufen.
        await schlange.fertig().catch(() => {});
        if (e instanceof Abgebrochen) throw e;
        throw new Error(
          `Innenteil ${innenteil.name} liess sich nicht rendern: ` +
            `${cleanError(e) ?? "Fehler"}. Der Lauf ist abgebrochen.`,
        );
      }
      // Die Textebene geht als eine kleine Datei hoch, nachdem alle Seiten
      // durch sind. Scheitert sie, fehlt nur die genaue Lage der
      // Verzeichniseintraege — der Import selbst laeuft weiter.
      const textSeiten = textebene.filter(Boolean);
      if (textSeiten.length) {
        melde("innenteil", "Textebene geht hoch", 1);
        try {
          const textBlob = textebeneAlsBlob(textSeiten);
          const { assetId } = await uploadAsset(deps, issueId, textBlob, "textebene.json");
          await addSource({
            issueId,
            assetId,
            kind: "text",
            role: "inner",
            filename: "textebene.json",
            pageCount: textSeiten.length,
          });
          hochgeladen += textBlob.size;
          notiere(`Textebene: ${textSeiten.length} Seiten (${formatBytes(textBlob.size)})`);
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(
            `Textebene nachtragen (Importdialog) — ${cleanError(e) ?? "nicht hochgeladen"}`,
          );
        }
      }
      await innenPdf.schliessen();
      innenPdf = null;
      // Die Seiten zeigen auf sich selbst; ein Innenteil-Asset gibt es nicht
      // mehr. Fuer die Reihenfolge zaehlt nur noch die Liste.
      const innerAsset = innenSeiten[0]?.assetId as Id<"assets">;
      const innenSekunden = (performance.now() - innenStart) / 1000;
      notiere(
        `Innenteil ${innenteil.name}: ${innerSeiten} Seiten gerendert, ` +
          `${formatBytes(innenteil.size)} Druckdatei bleibt hier ` +
          `(${innenSekunden.toFixed(0)} s mit ${RENDER_SPUREN} Spuren, ` +
          `${(uploadWarten / 1000).toFixed(0)} s davon Warten auf die Leitung, summiert)`,
      );
      if (!innerSeiten) {
        offen.push("Der Innenteil ergab keine Seiten — bitte die Datei prüfen");
      }
      abhaken("innenteil");
      pruefen();

      // Der Umschlag geht denselben Weg: gerendert wird hier, hoch gehen die
      // Seiten. Er traegt keinen Satz, deshalb bleibt sein Anschnitt stehen —
      // ein Umschlagbogen wird ohnehin in Haelften gelesen.
      let coverPdf:
        | {
            assetId: Id<"assets">;
            pageCount: number;
            rendered: {
              assetId: Id<"assets">;
              previewKey: string;
              width: number;
              height: number;
            }[];
          }
        | undefined;
      if (plan.cover) {
        const umschlag = plan.cover;
        melde("umschlag", `Umschlag ${umschlag.name} wird gerendert`);
        try {
          const seiten: {
            assetId: Id<"assets">;
            previewKey: string;
            width: number;
            height: number;
          }[] = [];
          await renderPdfPages(
            umschlag.file,
            { targetWidth: SEITEN_BREITE, quality: SEITEN_GUETE },
            async (seite, i, total) => {
              pruefen();
              melde("umschlag", `Umschlagseite ${i + 1} von ${total}`, (i + 1) / total);
              const dateiname = `umschlag-${String(i + 1).padStart(2, "0")}.jpg`;
              await schlange.einreihen(async () => {
                const { assetId, key } = await uploadAsset(
                  deps,
                  issueId,
                  seite.blob,
                  dateiname,
                  "page",
                );
                seiten[i] = {
                  assetId,
                  previewKey: key,
                  width: seite.width,
                  height: seite.height,
                };
                hochgeladen += seite.blob.size;
              });
            },
            () => abbrechen.current,
          );
          await schlange.fertig();
          if (seiten.length) {
            coverPdf = {
              assetId: seiten[0].assetId,
              pageCount: seiten.length,
              rendered: seiten,
            };
            notiere(`Umschlag ${umschlag.name}: ${seiten.length} Seiten gerendert`);
          }
        } catch (e: any) {
          if (e instanceof Abgebrochen) throw e;
          offen.push(
            `Umschlag ${umschlag.name} nachtragen — ${cleanError(e) ?? "nicht gerendert"}`,
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
          const { assetId } = await uploadAsset(deps, issueId, satz.file, satz.name);
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
      let coverImageAsset:
        | { assetId: Id<"assets">; previewKey: string; width: number; height: number }
        | undefined;
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
          const titelbild = await uploadAsset(
            deps,
            issueId,
            bild.blob,
            dateiname,
            "source",
          );
          coverImageAsset = {
            assetId: titelbild.assetId,
            previewKey: titelbild.key,
            width: bild.width,
            height: bild.height,
          };
          await addSource({
            issueId,
            assetId: titelbild.assetId,
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
        const bilderschlange = new Ladeschlange(GLEICHZEITIGE_UPLOADS);
        // So viele Bilder werden gleichzeitig umgewandelt, wie es Faeden gibt.
        // Frueher wartete die Schleife auf jedes Bild einzeln, und der zweite
        // Faden stand still.
        const umwandlung = new Ladeschlange(FAEDEN);
        let fertigeBilder = 0;
        for (let i = 0; i < gesamt; i++) {
          pruefen();
          const datei = plan.artwork[i];
          await umwandlung.einreihen(async () => {
            try {
              const bild = await wandler.convert(
                datei.file,
                datei.name,
                ARTWORK_KANTE,
                ARTWORK_GUETE,
              );
              vorher += datei.size;
              // Das naechste Bild wird schon umgewandelt, waehrend dieses hochgeht.
              await bilderschlange.einreihen(async () => {
                const { assetId } = await uploadAsset(
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
                nachher += bild.blob.size;
              });
            } catch (e: any) {
              // Ein einzelnes Bild haelt den Lauf nie an. Ein Upload-Fehler
              // kommt ueber die Bilderschlange und bricht dort ab.
              uebergangen++;
              const grund = cleanError(e) ?? "nicht lesbar";
              notiere(`Bild übergangen: ${datei.name} (${grund})`);
              offen.push(`Bild ${datei.name} nachtragen — ${grund}`);
            } finally {
              fertigeBilder++;
              melde(
                "bilder",
                `Bild ${fertigeBilder} von ${gesamt}: ${datei.name}`,
                fertigeBilder / gesamt,
              );
            }
          });
        }
        await umwandlung.fertig();
        await bilderschlange.fertig();
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
            inner: {
              assetId: innerAsset,
              pageCount: innerSeiten,
              rendered: innenSeiten,
            },
            cover: coverPdf,
            coverImage: coverImageAsset,
            printedStart: gedruckteStartseite,
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
      // Der Balken bleibt stehen, wo der Lauf endete, und sagt es: ohne das
      // sah ein abgebrochener Lauf aus, als liefe er noch.
      setLauf((alt) => ({
        text: `Abgebrochen bei: ${alt?.text ?? "Start"}`,
        prozent: alt?.prozent ?? 0,
        fehler: true,
      }));
      if (e instanceof Abgebrochen) {
        setErr("Abgebrochen. Was bis dahin hochging, steht schon am Heft.");
      } else {
        setErr(cleanError(e) ?? "Fehler");
      }
    } finally {
      await innenPdf?.schliessen().catch(() => {});
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
          in dem Augenblick, in dem der Lauf anfaengt. Die gedruckte Seitenzahl
          steht nicht dabei — sie kommt aus dem Satz. */}
      <div className="import-optionen">
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
        <div
          className={`lauf${lauf.fehler ? " fehler" : ""}`}
          role="status"
          aria-live="polite"
        >
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
