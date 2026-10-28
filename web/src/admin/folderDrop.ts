/**
 * Einen fallen gelassenen Ordner einlesen.
 *
 * Der Browser reicht einen Ordner nicht als Liste heraus, sondern als Baum,
 * der haeppchenweise gelesen werden will: `readEntries` liefert hoechstens
 * hundert Eintraege je Aufruf und ist erst leer, wenn nichts mehr kommt.
 */

import { parseFolderName, type ScannedFile } from "./folderScan";

export type DroppedFolder = { folderName: string; files: ScannedFile[] };

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
  const eintraege: FileSystemDirectoryEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry?.isDirectory) eintraege.push(entry as FileSystemDirectoryEntry);
  }
  const out: DroppedFolder[] = [];
  for (const ordner of eintraege) {
    const files: ScannedFile[] = [];
    await walk(ordner, "", files);
    out.push(...aufteilen({ folderName: ordner.name, files }));
  }
  return out;
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
