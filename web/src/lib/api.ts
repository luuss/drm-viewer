import { api as generated } from "../../../convex/_generated/api";

export const api = generated;
export type { Id } from "../../../convex/_generated/dataModel";

/** Adresse des Kachel-Gateways; im Betrieb hinter derselben Domain. */
export const TILE_SERVICE_URL = (
  (import.meta.env.VITE_TILE_SERVICE_URL as string) || "http://localhost:8000"
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
