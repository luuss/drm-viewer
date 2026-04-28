import { TILE_SERVICE_URL } from "../lib/convex";

export type TokenBundle = {
  tokens: Record<string, string>;
  decoys: string[];
  pageCount: number;
};

export async function fetchTokens(
  sessionToken: string,
  bookId: string,
  page: number,
): Promise<TokenBundle> {
  const res = await fetch(
    `${TILE_SERVICE_URL}/api/book/${bookId}/page/${page}/tokens`,
    { headers: { "X-Tile-Session": sessionToken } },
  );
  if (!res.ok) throw new Error(`tokens failed: ${res.status}`);
  return res.json();
}

export async function fetchTile(
  sessionToken: string,
  bookId: string,
  page: number,
  row: number,
  col: number,
  token: string,
): Promise<Blob> {
  const url = `${TILE_SERVICE_URL}/api/book/${bookId}/page/${page}/tile/${row}/${col}?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { "X-Tile-Session": sessionToken } });
  if (!res.ok) throw new Error(`tile failed: ${res.status}`);
  return res.blob();
}

export function fireDecoy(sessionToken: string, id: string) {
  fetch(`${TILE_SERVICE_URL}/api/decoy/${id}`, {
    headers: { "X-Tile-Session": sessionToken },
  }).catch(() => {});
}
