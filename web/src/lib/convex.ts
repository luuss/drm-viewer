import { api as _api } from "../../../convex/_generated/api";

export const api = _api;
export type { Id } from "../../../convex/_generated/dataModel";

export const TILE_SERVICE_URL = (
  (import.meta.env.VITE_TILE_SERVICE_URL as string) || "http://localhost:8000"
).replace(/\/$/, "");
