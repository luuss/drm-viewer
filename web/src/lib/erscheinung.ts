/**
 * Erscheinungsdatum eines Hefts. Gespeichert ist der erste Tag des
 * Erscheinungsmonats; der Tag sagt also nichts, gezeigt werden Monat und
 * Jahr ("März 2026"). Gerechnet wird in deutscher Zeit, damit der Monat
 * nicht kippt, ob das Datum nun als Mitternacht UTC oder als Mitternacht in
 * Berlin gespeichert ist.
 */
import { monateDerNummer, MONATSNAMEN } from "../../../convex/heftnummer";

const ZEITZONE = "Europe/Berlin";

export function monatJahr(ms: number): string {
  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
    timeZone: ZEITZONE,
  }).format(new Date(ms));
}

/**
 * Nennt die Bezeichnung des Hefts den Erscheinungsmonat schon ("März 2026",
 * "März-April 2026", "Sept./Okt. 2026", "3/2026")? Dann steht das Datum nicht
 * noch einmal daneben.
 */
export function nenntMonat(texte: (string | null | undefined)[], ms: number): boolean {
  const teile = new Intl.DateTimeFormat("de-DE", {
    month: "numeric",
    year: "numeric",
    timeZone: ZEITZONE,
  }).formatToParts(new Date(ms));
  const monat = Number(teile.find((t) => t.type === "month")?.value);
  const jahr = teile.find((t) => t.type === "year")?.value ?? "";
  const name = monatJahr(ms).split(" ")[0].toLowerCase();
  // Ganze Monatsnamen und die ueblichen Kuerzel, jeweils als ganzes Wort:
  // "Mainzer" ist kein Mai, "Augenzeugen" kein August.
  const KUERZEL: Record<string, string[]> = {
    januar: ["jan"], februar: ["feb"], märz: ["mär", "mrz", "maerz"], april: ["apr"],
    august: ["aug"], september: ["sep", "sept"], oktober: ["okt"], november: ["nov"],
    dezember: ["dez"],
  };
  const namen = [name, ...(KUERZEL[name] ?? [])];
  const wort = new RegExp(`(^|[^\\p{L}])(${namen.join("|")})(?![\\p{L}])`, "u");
  const zahl = new RegExp(`(^|\\D)0?${monat}\\s*[/.-]\\s*(${jahr}|${jahr.slice(2)})(\\D|$)`);
  return texte.some((roh) => {
    const text = (roh ?? "").toLowerCase();
    if (!jahr) return false;
    if (zahl.test(text)) return true;
    return text.includes(jahr) && wort.test(text);
  });
}

function monatUndJahr(ms: number): { monat: number; jahr: number } {
  const teile = new Intl.DateTimeFormat("de-DE", {
    month: "numeric",
    year: "numeric",
    timeZone: ZEITZONE,
  }).formatToParts(new Date(ms));
  return {
    monat: Number(teile.find((t) => t.type === "month")?.value),
    jahr: Number(teile.find((t) => t.type === "year")?.value),
  };
}

/**
 * Erscheinungszeitraum fuer die Anzeige. Gespeichert ist nur der erste Monat;
 * ein Doppelheft ("8-9/2025") erscheint aber fuer zwei: "August/September
 * 2025" statt "August 2025". Passt die Nummer nicht zum Datum, gilt das Datum.
 */
export function erscheinungText(ms: number, issueNumber?: string | null): string {
  const nr = monateDerNummer(issueNumber);
  const { monat, jahr } = monatUndJahr(ms);
  if (nr && nr.von !== nr.bis && nr.von === monat && nr.jahr === jahr) {
    return `${MONATSNAMEN[nr.von - 1]}/${MONATSNAMEN[nr.bis - 1]} ${jahr}`;
  }
  return monatJahr(ms);
}

/**
 * Nennt die Bezeichnung den ganzen Zeitraum schon? Bei einem Einzelheft wie
 * `nenntMonat`. Bei einem Doppelheft muessen beide Monate als Wort dastehen
 * ("August/September 2025"); "8-9/2025" im Titel reicht nicht, sonst stuende
 * der Zeitraum nirgends ausgeschrieben.
 */
export function nenntZeitraum(
  texte: (string | null | undefined)[],
  ms: number,
  issueNumber?: string | null,
): boolean {
  const nr = monateDerNummer(issueNumber);
  const { monat, jahr } = monatUndJahr(ms);
  if (!nr || nr.von === nr.bis || nr.von !== monat || nr.jahr !== jahr) {
    return nenntMonat(texte, ms);
  }
  const zweiter = Date.UTC(nr.jahr, nr.bis - 1, 15);
  const nurWorte = texte.map((t) => (t ?? "").replace(/\d{1,2}\s*[-/+]\s*\d{1,2}\s*\/\s*\d{4}/g, " "));
  return nenntMonat(nurWorte, ms) && nenntMonat(nurWorte, zweiter);
}
