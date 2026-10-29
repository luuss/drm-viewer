/**
 * Erscheinungsdatum eines Hefts. Gespeichert ist der erste Tag des
 * Erscheinungsmonats; der Tag sagt also nichts, gezeigt werden Monat und
 * Jahr ("März 2026"). Gerechnet wird in deutscher Zeit, damit der Monat
 * nicht kippt, ob das Datum nun als Mitternacht UTC oder als Mitternacht in
 * Berlin gespeichert ist.
 */
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
