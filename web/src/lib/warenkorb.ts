import { useSyncExternalStore } from "react";

/**
 * Warenkorb im Leser: nur eine Auswahl von Heften im Browser. Bezahlt wird im
 * Laden; „Zur Kasse“ legt die Hefte dort ueber `lusdigital/warenkorb` in den
 * Warenkorb und oeffnet die Kasse.
 */
const KEY = "lus-warenkorb";

type Liste = string[];

function lesen(): Liste {
  try {
    const roh = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(roh) ? roh.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let stand: Liste = lesen();
const hoerer = new Set<() => void>();

function schreiben(neu: Liste) {
  stand = neu;
  localStorage.setItem(KEY, JSON.stringify(neu));
  hoerer.forEach((h) => h());
}

// Andere Tabs halten denselben Stand.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  stand = lesen();
  hoerer.forEach((h) => h());
});

function abonnieren(h: () => void) {
  hoerer.add(h);
  return () => hoerer.delete(h);
}

/** Ausgewaehlte Hefte (Issue-IDs), aelteste zuerst. */
export function useWarenkorb(): Liste {
  return useSyncExternalStore(abonnieren, () => stand);
}

export function hinein(issueId: string) {
  if (!stand.includes(issueId)) schreiben([...stand, issueId]);
}

export function heraus(issueId: string) {
  schreiben(stand.filter((id) => id !== issueId));
}

export function leeren() {
  schreiben([]);
}

/**
 * Adresse, die die Artikel im Laden in den Warenkorb legt und in die Kasse
 * springt. Die E-Mail des Leser-Kontos wird dort vorbelegt, weil die
 * Freischaltung an ihr haengt.
 */
export function kassenUrl(shopUrl: string, skus: string[], email?: string | null): string {
  const url = new URL("module/lusdigital/warenkorb", shopUrl.endsWith("/") ? shopUrl : `${shopUrl}/`);
  url.searchParams.set("artikel", skus.join(","));
  if (email) url.searchParams.set("email", email);
  return url.toString();
}
