/**
 * Regeln fuer die Anmeldung per E-Mail-Link, ohne Convex-Bezug.
 * Die Weboberflaeche benutzt dieselben Funktionen (Zielpfad pruefen).
 */

/** Ein Link gilt 15 Minuten und nur einmal. */
export const LINK_TTL_MS = 15 * 60 * 1000;

/** Hoechstens so viele Links je Adresse und Stunde. Der Shop prueft dasselbe. */
export const MAX_PER_EMAIL_PER_HOUR = 5;

/** Hoechstens so viele Links je IP-Adresse und Stunde. */
export const MAX_PER_IP_PER_HOUR = 20;

/** Notbremse fuer den ganzen Leser, schuetzt den Ruf des Shop-Mailversands. */
export const MAX_TOTAL_PER_HOUR = 500;

/** Angemeldete Browser je Konto. Der naechste Login beendet den aeltesten. */
export const DEFAULT_MAX_LOGINS = 2;

/** Zielseite nach der Anmeldung, wenn nichts anderes angegeben ist. */
export const DEFAULT_NEXT = "/library";

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Grobe Pruefung; die eigentliche Pruefung ist, dass der Link ankommt. */
export function isPlausibleEmail(email: string): boolean {
  if (email.length < 6 || email.length > 254) return false;
  return /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[a-z]{2,}$/i.test(email);
}

/**
 * Zielpfad nach der Anmeldung. Nur Pfade auf derselben Seite: kein Protokoll,
 * kein fremder Host (`//evil`, `/\evil`), keine Steuerzeichen, keine Schleife
 * zurueck auf die Anmeldung.
 */
export function safeNext(next: unknown, fallback: string = DEFAULT_NEXT): string {
  if (typeof next !== "string") return fallback;
  const n = next.trim();
  if (n.length === 0 || n.length > 300) return fallback;
  if (!n.startsWith("/") || n.startsWith("//")) return fallback;
  if (/[\\\s\u0000-\u001f\u007f]/.test(n)) return fallback;
  if (/^\/(login|anmelden|claim)(\/|\?|#|$)/i.test(n)) return fallback;
  return n;
}

/** Der Link in der Mail. `base` ohne Schraegstrich am Ende. */
export function buildLoginLink(base: string, token: string, next: string): string {
  const url = `${base.replace(/\/$/, "")}/anmelden?t=${encodeURIComponent(token)}`;
  return next === DEFAULT_NEXT ? url : `${url}&next=${encodeURIComponent(next)}`;
}

/** Form der Tokens, die `newToken` erzeugt (base64url, 43 Zeichen). */
export function looksLikeToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(token);
}
