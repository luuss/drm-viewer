/**
 * Regeln fuer Uploads. Bewusst in einem eigenen Modul, damit der vermittelte
 * und der direkte Weg dieselben Pruefungen benutzen.
 */

const ALLOWED = new Map<string, string[]>([
  ["application/pdf", [".pdf"]],
  ["application/vnd.adobe.indesign-idml-package", [".idml"]],
  ["application/octet-stream", [".idml", ".indd"]],
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
]);

export const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? String(600 * 1024 * 1024),
);

export function assertUploadAllowed(
  contentType: string,
  bytes: number,
  filename: string,
): void {
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Datei zu groß (${Math.round(bytes / 1024 / 1024)} MB, erlaubt sind ` +
        `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`,
    );
  }
  const endings = ALLOWED.get(contentType);
  const lower = filename.toLowerCase();
  // Browser melden IDML und INDD oft als octet-stream; dann zaehlt die Endung.
  if (!endings?.some((e) => lower.endsWith(e))) {
    throw new Error(`Dateityp nicht erlaubt: ${contentType} (${filename})`);
  }
}
