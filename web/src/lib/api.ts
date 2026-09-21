import { api as generated } from "../../../convex/_generated/api";

export const api = generated;
export type { Id } from "../../../convex/_generated/dataModel";

/** Im Betrieb laeuft das Kachel-Gateway unter /api auf derselben Domain. */
const configuredTileService = (
  (import.meta.env.VITE_TILE_SERVICE_URL as string | undefined) ?? ""
).trim();
export const TILE_SERVICE_URL = (
  configuredTileService ||
  (import.meta.env.DEV ? "http://localhost:8000" : window.location.origin)
).replace(/\/$/, "");

/** Basis-Pfad, falls die App unter einem Unterpfad laeuft. */
export const BASE_PATH = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Serverfehler lesbar machen. Convex haengt Anfragekennung und Aufrufort an;
 * davon soll in der Oberflaeche nur der Satz stehen, der die Redaktion angeht.
 */
export function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const match = raw.match(/Uncaught Error:\s*([\s\S]*?)(?:\n|\s+at\s|$)/);
  const text = (match?.[1] ?? raw).replace(/^\[.*?\]\s*/, "").trim();
  return text || "Unbekannter Fehler";
}
