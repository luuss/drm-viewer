/**
 * Erscheinungsmonat aus einer Ausgabebezeichnung des Ladens ("April 2025",
 * "Ausgabe März/April 2026", "Juli–August 2025"). Wie im Import
 * (extract-service/extractor/issue_meta.py): der erste Tag des ersten Monats,
 * UTC. Ohne eindeutigen Monat und Jahr bleibt es leer.
 */
const MONATE: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, marz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};
const MONAT = Object.keys(MONATE).join("|");
const ZEITRAUM = new RegExp(`(?<![\\p{L}])(${MONAT})\\s*(?:[–/-]|bis)\\s*(${MONAT})\\s*(20\\d\\d)\\b`, "iu");
const EINZELMONAT = new RegExp(`(?<![\\p{L}])(${MONAT})\\s*(20\\d\\d)\\b`, "iu");

export function erscheinungAusBezeichnung(...texte: (string | null | undefined)[]): number | null {
  for (const text of texte) {
    if (!text) continue;
    const treffer = ZEITRAUM.exec(text) ?? EINZELMONAT.exec(text);
    if (!treffer) continue;
    const monat = MONATE[treffer[1].toLowerCase()];
    const jahr = Number(treffer[treffer.length - 1]);
    if (monat && jahr) return Date.UTC(jahr, monat - 1, 1);
  }
  return null;
}
