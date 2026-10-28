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

export type UploadKind = "source" | "image" | "cover" | "page";

export type Uploaded = { assetId: Id<"assets">; key: string };

/** So oft wird ein abgebrochener Upload in den Medienspeicher wiederholt. */
const VERSUCHE = 4;

/**
 * Gibt neben der Kennung auch die Adresse zurueck: wer eine gerenderte Seite
 * hochlaedt, muss sie spaeter am Heft eintragen koennen, und dafuer zaehlt der
 * Schluessel im Speicher, nicht der Dateiname.
 */
export async function uploadAsset(
  deps: UploadDeps,
  issueId: Id<"issues">,
  data: Blob,
  filename: string,
  kind: UploadKind = "source",
): Promise<Uploaded> {
  const contentType = data.type || "application/octet-stream";
  // Zwischen Cloudflare und dem Server reisst ab und zu eine Verbindung
  // mitten im Hochladen ab (Apache: "read request body failed"), MinIO
  // antwortet dann 400. Am 28.10.2026 drei von 2.840 Seiten, und jede hat
  // den ganzen Lauf beendet. Deshalb: neu signieren und noch einmal.
  let direct: { url: string; key: string } | null = null;
  for (let versuch = 1; ; versuch++) {
    direct = await deps.presignUpload({
      issueId,
      filename,
      contentType,
      bytes: data.size,
    });
    if (!direct) break;
    let status = 0;
    try {
      const put = await fetch(direct.url, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: data,
      });
      if (put.ok) break;
      status = put.status;
    } catch {
      status = 0;
    }
    // 403 heisst: Signatur oder Rechte falsch, da hilft kein zweiter Versuch.
    if (versuch >= VERSUCHE || status === 403) {
      throw new Error(
        `Direkter Upload abgelehnt (${status || "Verbindung abgebrochen"}, ${versuch} Versuche)`,
      );
    }
    await new Promise((r) => setTimeout(r, 1500 * versuch));
  }
  if (direct) {
    const assetId = await deps.registerUpload({
      bucket: "emag-media",
      key: direct.key,
      contentType,
      kind,
      issueId,
      bytes: data.size,
      filename,
    });
    return { assetId, key: direct.key };
  }
  const url = await deps.generateUploadUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: data,
  });
  if (!res.ok) throw new Error(`Upload abgelehnt (${res.status})`);
  const { storageId } = await res.json();
  const key = `uploads/${issueId}/${filename}`;
  const assetId = await deps.registerUpload({
    storageId,
    key,
    contentType,
    kind,
    issueId,
    bytes: data.size,
    filename,
  });
  return { assetId, key };
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
