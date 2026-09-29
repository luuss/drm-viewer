import { safeNext, DEFAULT_NEXT } from "../../../convex/magicLinkRules";

export { safeNext, DEFAULT_NEXT };

/**
 * HTTP-Routen des Backends. Im Betrieb liegen sie unter /hooks auf derselben
 * Domain (Apache schneidet das Praefix ab), lokal auf Port 3211.
 */
export const HOOKS_URL = (
  ((import.meta.env.VITE_HOOKS_URL as string | undefined) ?? "").trim() ||
  (import.meta.env.DEV ? "http://localhost:3211" : `${window.location.origin}/hooks`)
).replace(/\/$/, "");

export type LinkErgebnis = "gesendet" | "zu_viele" | "adresse" | "fehler";

/** Anmeldelink anfordern. Sagt nie, ob es die Adresse schon gibt. */
export async function linkAnfordern(email: string, next?: string): Promise<LinkErgebnis> {
  try {
    const res = await fetch(`${HOOKS_URL}/auth/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), next: safeNext(next) }),
    });
    if (res.ok) return "gesendet";
    if (res.status === 429) return "zu_viele";
    if (res.status === 400) return "adresse";
    return "fehler";
  } catch {
    return "fehler";
  }
}

/** Merker fuer die Anmeldeseite: dieser Browser wurde von aussen abgemeldet. */
export const ABGEMELDET_KEY = "lus.abgemeldet";

/** Kurzer Geraetename fuer die Kontoseite, z. B. "Chrome auf Android". */
export function geraetName(ua: string = navigator.userAgent): string {
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser\//.test(ua)
      ? "Samsung Internet"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Browser";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return system ? `${browser} auf ${system}` : browser;
}
