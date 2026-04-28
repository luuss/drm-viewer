import { api as _api } from "../../../convex/_generated/api";
import type { Id as _Id } from "../../../convex/_generated/dataModel";

export const api = _api;
export type Id<T extends string> = _Id<T>;

export const TILE_SERVICE_URL = (
  (import.meta.env.VITE_TILE_SERVICE_URL as string) || "http://localhost:8000"
).replace(/\/$/, "");
