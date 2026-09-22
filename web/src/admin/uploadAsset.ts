/**
 * Eine Datei in den Medienspeicher legen und als Asset eintragen.
 *
 * Es gibt zwei Wege. Ist ein Medienspeicher eingerichtet, bekommt der Browser
 * eine kurzlebige signierte Adresse und laedt direkt dorthin — ein Heft von
 * hundertvierzig Megabyte laeuft dann nicht durch den Server. Sonst geht die
 * Datei ueber die Convex-Ablage.
 */

import type { Id } from "../lib/api";

export type UploadDeps = {
  presignUpload: (args: {
    issueId: Id<"issues">;
    filename: string;
    contentType: string;
    bytes: number;
  }) => Promise<{ url: string; key: string } | null>;
  registerUpload: (args: {
    storageId?: Id<"_storage">;
    bucket?: string;
    key: string;
    contentType: string;
    kind: UploadKind;
    issueId?: Id<"issues">;
    bytes?: number;
    filename?: string;
  }) => Promise<Id<"assets">>;
  generateUploadUrl: () => Promise<string>;
};

export type UploadKind = "source" | "image" | "cover";

export async function uploadAsset(
  deps: UploadDeps,
  issueId: Id<"issues">,
  data: Blob,
  filename: string,
  kind: UploadKind = "source",
): Promise<Id<"assets">> {
  const contentType = data.type || "application/octet-stream";
  const direct = await deps.presignUpload({
    issueId,
    filename,
    contentType,
    bytes: data.size,
  });
  if (direct) {
    const put = await fetch(direct.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: data,
    });
    if (!put.ok) throw new Error(`Direkter Upload abgelehnt (${put.status})`);
    return await deps.registerUpload({
      bucket: "emag-media",
      key: direct.key,
      contentType,
      kind,
      issueId,
      bytes: data.size,
      filename,
    });
  }
  const url = await deps.generateUploadUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: data,
  });
  if (!res.ok) throw new Error(`Upload abgelehnt (${res.status})`);
  const { storageId } = await res.json();
  return await deps.registerUpload({
    storageId,
    key: `uploads/${issueId}/${filename}`,
    contentType,
    kind,
    issueId,
    bytes: data.size,
    filename,
  });
}

/**
 * Seitenzahl eines PDF ohne Bibliothek bestimmen: zaehlt die Seitenobjekte in
 * der Datei, stueckweise, damit ein Heft von hundertvierzig Megabyte nicht am
 * Stueck im Speicher liegt. Bei komprimierten Objektstroemen findet sich
 * nichts; dann bleibt die Zahl offen und die Redaktion traegt sie ein.
 */
export async function countPdfPages(file: Blob): Promise<number | undefined> {
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
