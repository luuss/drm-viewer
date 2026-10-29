/**
 * Erneut laden statt haengen bleiben.
 *
 * Das Kachel-Gateway bremst je Leser und Heft (`tile-service/main.py`,
 * `check_rate`) und antwortet dann mit 429 und `Retry-After`. Frueher blieb
 * die Seite danach bis zu einer Minute leer stehen. Jetzt wartet der Leser
 * kurz und fragt von selbst noch einmal. Ein Netzfehler oder ein Fehler des
 * Servers (502, 521 …) bekommt genau einen zweiten Versuch; danach entscheidet
 * der Leser selbst ("Erneut versuchen").
 */

/** So oft fragt der Leser nach einem 429 nach, zusammen gut eine Minute. */
const GEBREMST_VERSUCHE = 12;
const GEBREMST_MIN_MS = 1000;
const GEBREMST_MAX_MS = 8000;
const FEHLER_WARTEN_MS = 1000;

/** Was eine Anfrage ergab: der Status oder "netz", wenn keine Antwort kam. */
export type Ausgang = number | "netz";

/**
 * Wartezeit bis zum naechsten Versuch in Millisekunden, oder null: nicht
 * noch einmal. `versuch` zaehlt die schon gemachten Wiederholungen ab 0.
 */
export function nochmalNach(
  ausgang: Ausgang,
  versuch: number,
  retryAfter?: string | null,
): number | null {
  if (ausgang === 429) {
    if (versuch >= GEBREMST_VERSUCHE) return null;
    const sekunden = Number(retryAfter);
    const ms =
      retryAfter && Number.isFinite(sekunden)
        ? sekunden * 1000
        : GEBREMST_MIN_MS * 1.5 ** versuch;
    return Math.round(Math.min(GEBREMST_MAX_MS, Math.max(GEBREMST_MIN_MS, ms)));
  }
  if (ausgang === "netz" || ausgang >= 500) {
    return versuch === 0 ? FEHLER_WARTEN_MS : null;
  }
  return null;
}

function warten(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((ok, fehler) => {
    if (signal.aborted) {
      fehler(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopp);
      ok();
    }, ms);
    const stopp = () => {
      clearTimeout(timer);
      fehler(signal.reason ?? new DOMException("Abgebrochen", "AbortError"));
    };
    signal.addEventListener("abort", stopp, { once: true });
  });
}

/**
 * Anfrage mit den Wiederholungen von `nochmalNach`. `hole` wird je Versuch
 * neu gerufen (ein Einmal-Ticket gilt nur einmal). Zurueck kommt die letzte
 * Antwort, auch eine misslungene; kam gar keine, der letzte Netzfehler.
 * `beimWarten` meldet jede Pause, etwa fuer "Seite wird gleich geladen".
 * `bisMs` begrenzt die ganze Kette: eine Pause, die darueber hinausginge,
 * wird nicht mehr gemacht (Kacheln: OpenSeadragon gibt einen Auftrag nach
 * 30 s ohnehin auf). Ein Abbruch (AbortError) beendet die Kette sofort.
 */
export async function mitWiederholung(
  hole: () => Promise<Response>,
  signal: AbortSignal,
  beimWarten?: (ausgang: Ausgang) => void,
  { bisMs = Infinity }: { bisMs?: number } = {},
): Promise<Response> {
  const beginn = Date.now();
  for (let versuch = 0; ; versuch++) {
    let antwort: Response | null = null;
    let fehler: unknown = null;
    try {
      antwort = await hole();
    } catch (e) {
      if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
      fehler = e;
    }
    if (antwort?.ok) return antwort;
    const ausgang: Ausgang = antwort ? antwort.status : "netz";
    let ms = nochmalNach(ausgang, versuch, antwort?.headers.get("Retry-After"));
    if (ms !== null && Date.now() - beginn + ms > bisMs) ms = null;
    if (ms === null) {
      if (antwort) return antwort;
      throw fehler;
    }
    beimWarten?.(ausgang);
    await warten(ms, signal);
  }
}
