import { useSyncExternalStore } from "react";

/**
 * Warenkorb im Leser: nur eine Auswahl von Heften und Digital-Abos im
 * Browser. Bezahlt wird im Laden; „Zur Kasse“ legt alles dort ueber
 * `lusdigital/warenkorb` in den Warenkorb und oeffnet die Kasse.
 *
 * Ein Eintrag ist die ID eines Hefts oder `abo:<ID der Reihe>`.
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

const ABO = "abo:";

/** Eintrag fuer das Digital-Abo einer Reihe. */
export function aboEintrag(publicationId: string): string {
  return `${ABO}${publicationId}`;
}

/** Reihe eines Abo-Eintrags, bei einem Heft null. */
export function aboReihe(eintrag: string): string | null {
  return eintrag.startsWith(ABO) ? eintrag.slice(ABO.length) : null;
}

/** Ausgewaehlte Eintraege (Hefte und Abos), aelteste zuerst. */
export function useWarenkorb(): Liste {
  return useSyncExternalStore(abonnieren, () => stand);
}

export function hinein(eintrag: string) {
  if (!stand.includes(eintrag)) schreiben([...stand, eintrag]);
}

export function heraus(eintrag: string) {
  schreiben(stand.filter((id) => id !== eintrag));
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
