/**
 * Einen fallen gelassenen Ordner einlesen.
 *
 * Der Browser reicht einen Ordner nicht als Liste heraus, sondern als Baum,
 * der haeppchenweise gelesen werden will: `readEntries` liefert hoechstens
 * hundert Eintraege je Aufruf und ist erst leer, wenn nichts mehr kommt.
 */

import { parseFolderName, type ScannedFile } from "./folderScan";

export type DroppedFolder = {
  folderName: string;
  files: ScannedFile[];
  /** Pfad im Heftarchiv ("weltkrieg/Großbände/…"); fehlt beim einzeln gezogenen Ordner. */
  pfad?: string;
};

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(
  dir: FileSystemDirectoryEntry,
  prefix: string,
  out: ScannedFile[],
): Promise<void> {
  const reader = dir.createReader();
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) break;
    for (const entry of batch) {
      if (entry.isFile) {
        const file = await fileOf(entry as FileSystemFileEntry);
        out.push({
          path: prefix + entry.name,
          name: entry.name,
          size: file.size,
          file,
        });
      } else if (entry.isDirectory) {
        await walk(entry as FileSystemDirectoryEntry, prefix + entry.name + "/", out);
      }
    }
  }
}

/**
 * Ein Sammelordner voller Heftordner wird in seine Hefte geteilt. Erkannt
 * wird er streng, denn ein Heftordner hat oft selbst Unterordner (`PDF/`,
 * `Innenteil/`, `Umschlag/`), und ein falsch geteiltes Heft verliert seine
 * IDML (28.10.2026). Sammelordner heisst: oben liegt keine Heftdatei, und
 * mindestens zwei Unterordner mit PDF tragen verschiedene Heftnummern im Namen.
 */
export function aufteilen(ordner: DroppedFolder): DroppedFolder[] {
  const heftdatei = (name: string) => /\.(pdf|idml|indd)$/i.test(name);
  if (ordner.files.some((f) => !f.path.includes("/") && heftdatei(f.name))) return [ordner];
  const gruppen = new Map<string, ScannedFile[]>();
  for (const f of ordner.files) {
    const schnitt = f.path.indexOf("/");
    if (schnitt < 0) continue;
    const name = f.path.slice(0, schnitt);
    const liste = gruppen.get(name) ?? [];
    liste.push({ ...f, path: f.path.slice(schnitt + 1) });
    gruppen.set(name, liste);
  }
  const hefte = [...gruppen]
    .filter(([, files]) => files.some((f) => /\.pdf$/i.test(f.name)))
    .sort(([a], [b]) => a.localeCompare(b, "de", { numeric: true }))
    .map(([folderName, files]) => ({ folderName, files }));
  const nummern = new Set(hefte.map((h) => parseFolderName(h.folderName).issueNumber));
  if (hefte.length < 2 || nummern.has(undefined) || nummern.size !== hefte.length) {
    return [ordner];
  }
  return hefte;
}

/**
 * Alle Ordner eines Drops lesen, Sammelordner aufgeteilt. Einzelne Dateien
 * werden uebergangen.
 */
export async function readDroppedFolders(items: DataTransferItemList): Promise<DroppedFolder[]> {
  // Die Eintraege sofort abholen: nach dem ersten `await` ist die Liste leer.
  const eintraege: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) eintraege.push(entry);
  }
  const ordner: DroppedFolder[] = [];
  const lose: ScannedFile[] = [];
  for (const e of eintraege) {
    if (e.isDirectory) {
      const files: ScannedFile[] = [];
      await walk(e as FileSystemDirectoryEntry, "", files);
      ordner.push(...aufteilen({ folderName: e.name, files }));
    } else if (e.isFile) {
      const file = await fileOf(e as FileSystemFileEntry);
      lose.push({ path: e.name, name: e.name, size: file.size, file });
    }
  }
  return zusammenfuehren(ordner, lose);
}

/**
 * Was zusammen fallen gelassen wird, gehoert oft zu einem Heft: der
 * Heftordner, daneben `bilder 8-9-2025` und lose die IDML (28.10.2026). Ein
 * Ordner ohne PDF wird deshalb kein eigenes Heft, sondern geht in das Heft
 * mit derselben Heftnummer, oder in das einzige Heft des Drops. Lose Dateien
 * gehen in das einzige Heft.
 */
export function zusammenfuehren(ordner: DroppedFolder[], lose: ScannedFile[] = []): DroppedFolder[] {
  const hatPdf = (o: DroppedFolder) => o.files.some((f) => /\.pdf$/i.test(f.name));
  const hefte = ordner.filter(hatPdf).map((o) => ({ ...o, files: [...o.files] }));
  if (!hefte.length) {
    if (!lose.length) return ordner;
    // Nur lose Dateien, darunter PDFs (Weltkrieg-Baende kommen als einzelne
    // Datei, 03.11.2026): jedes PDF ist ein Heft, sein Dateiname der
    // Heftname. Gibt es genau ein PDF, gehen die anderen losen Dateien
    // (IDML, Titelbild) mit hinein.
    const pdfs = lose.filter((f) => /\.pdf$/i.test(f.name));
    if (!ordner.length && pdfs.length) {
      if (pdfs.length === 1) return [{ folderName: pdfs[0].name, files: [...lose] }];
      // Mehrere PDFs: eine Begleitdatei geht zu dem PDF mit gleichem
      // Dateistamm, sonst mit gleicher Heftnummer. Passt keins eindeutig,
      // bleibt sie draussen.
      const stamm = (n: string) => n.replace(/\.[^.]+$/, "").trim().toLowerCase();
      const hefteLos = pdfs.map((f) => ({ folderName: f.name, files: [f] }));
      for (const f of lose) {
        if (pdfs.includes(f)) continue;
        let ziel = hefteLos.filter((h) => stamm(h.folderName) === stamm(f.name));
        if (ziel.length !== 1) {
          const nr = parseFolderName(f.name).issueNumber;
          ziel = nr ? hefteLos.filter((h) => parseFolderName(h.folderName).issueNumber === nr) : [];
        }
        if (ziel.length === 1) ziel[0].files.push(f);
      }
      return hefteLos;
    }
    // Nur lose Dateien und Ordner ohne PDF: der erste Ordner gibt den Namen.
    return ordner.length
      ? [{ ...ordner[0], files: [...ordner[0].files, ...lose] }]
      : [];
  }
  const nummer = (o: DroppedFolder) => parseFolderName(o.folderName).issueNumber;
  const uebrig: DroppedFolder[] = [];
  for (const o of ordner.filter((x) => !hatPdf(x))) {
    const passend = hefte.filter((h) => nummer(h) && nummer(h) === nummer(o));
    const ziel = passend.length === 1 ? passend[0] : hefte.length === 1 ? hefte[0] : null;
    if (!ziel) {
      uebrig.push(o);
      continue;
    }
    ziel.files.push(...o.files.map((f) => ({ ...f, path: `${o.folderName}/${f.path}` })));
  }
  if (hefte.length === 1) hefte[0].files.push(...lose);
  return [...hefte, ...uebrig];
}

/** Ordner aus einem Drop lesen. Einzelne Dateien werden uebergangen. */
export async function readDroppedFolder(
  items: DataTransferItemList,
): Promise<DroppedFolder | null> {
  const eintraege: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) eintraege.push(entry);
  }
  const ordner = eintraege.find((e) => e.isDirectory) as
    | FileSystemDirectoryEntry
    | undefined;
  if (!ordner) return null;
  const files: ScannedFile[] = [];
  await walk(ordner, "", files);
  return { folderName: ordner.name, files };
}

/**
 * Rueckfallweg ueber ein Dateifeld mit `webkitdirectory`. Dort traegt jede
 * Datei ihren Pfad im Ordner selbst, der erste Teil ist der Ordnername.
 */
export function readDirectoryInput(list: FileList): DroppedFolder | null {
  const files: ScannedFile[] = [];
  let folderName = "";
  for (const file of Array.from(list)) {
    const relativ = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    if (!relativ) continue;
    const teile = relativ.split("/");
    folderName = folderName || teile[0];
    files.push({
      path: teile.slice(1).join("/"),
      name: file.name,
      size: file.size,
      file,
    });
  }
  if (!files.length) return null;
  return { folderName, files };
}

/** Eine Datei der Ordnerliste: Pfad, Groesse in Byte, Aenderungszeit (ms). */
export type ListenEintrag = [string, number, number];

/**
 * Nur die Struktur eines Drops lesen: Pfade, Groessen, Zeiten. Kein Byte
 * Inhalt wird gelesen; `entry.file()` liefert nur die Angaben der Datei.
 * Gedacht fuer das ganze Heftarchiv (300 GB) vor dem Massenimport.
 */
export async function strukturLesen(
  items: DataTransferItemList,
  onFortschritt?: (dateien: number, bytes: number) => void,
): Promise<{ wurzeln: string[]; dateien: ListenEintrag[]; bytes: number }> {
  const eintraege: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) eintraege.push(entry);
  }
  const dateien: ListenEintrag[] = [];
  let bytes = 0;
  const melden = () => onFortschritt?.(dateien.length, bytes);
  async function gehen(dir: FileSystemDirectoryEntry, prefix: string): Promise<void> {
    const reader = dir.createReader();
    for (;;) {
      const batch = await readBatch(reader);
      if (!batch.length) break;
      for (const entry of batch) {
        if (entry.isFile) {
          const file = await fileOf(entry as FileSystemFileEntry).catch(() => null);
          const groesse = file?.size ?? -1;
          dateien.push([prefix + entry.name, groesse, file?.lastModified ?? 0]);
          if (groesse > 0) bytes += groesse;
          if (dateien.length % 500 === 0) melden();
        } else if (entry.isDirectory) {
          await gehen(entry as FileSystemDirectoryEntry, prefix + entry.name + "/");
        }
      }
    }
  }
  for (const e of eintraege) {
    if (e.isDirectory) await gehen(e as FileSystemDirectoryEntry, e.name + "/");
    else if (e.isFile) {
      const file = await fileOf(e as FileSystemFileEntry).catch(() => null);
      dateien.push([e.name, file?.size ?? -1, file?.lastModified ?? 0]);
    }
  }
  melden();
  return { wurzeln: eintraege.map((e) => e.name), dateien, bytes };
}

/**
 * Alle Dateien eines Drops mit ihren Datei-Objekten, ohne etwas zu lesen.
 * Ein `File` aus `entry.file()` ist nur ein Verweis; gelesen wird erst, wenn
 * der Import die Datei wirklich braucht.
 */
export async function alleDateien(
  items: DataTransferItemList,
  onFortschritt?: (dateien: number) => void,
): Promise<ScannedFile[]> {
  const eintraege: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) eintraege.push(entry);
  }
  const out: ScannedFile[] = [];
  async function gehen(dir: FileSystemDirectoryEntry, prefix: string): Promise<void> {
    const reader = dir.createReader();
    for (;;) {
      const batch = await readBatch(reader);
      if (!batch.length) break;
      for (const entry of batch) {
        if (entry.isFile) {
          const file = await fileOf(entry as FileSystemFileEntry).catch(() => null);
          if (file) out.push({ path: prefix + entry.name, name: entry.name, size: file.size, file });
          if (out.length % 500 === 0) onFortschritt?.(out.length);
        } else if (entry.isDirectory) {
          await gehen(entry as FileSystemDirectoryEntry, prefix + entry.name + "/");
        }
      }
    }
  }
  for (const e of eintraege) {
    if (e.isDirectory) await gehen(e as FileSystemDirectoryEntry, e.name + "/");
  }
  onFortschritt?.(out.length);
  return out;
}
