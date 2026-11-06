/**
 * Der Titel eines Hefts aus dem Heft selbst (Weltkrieg-Leser, 05.11.2026).
 *
 * Erste Quelle ist der **Kolumnentitel**: oben auf den Seiten des Innenteils,
 * in Satzschrift und richtiger Schreibung, 20- bis 60-mal je Heft. Die
 * Titelseite (`umschlagTitel.ts`) ist nur die Gegenprobe: Versalien,
 * Zierschriften mit kaputter Textebene, jede Reihe anders gesetzt. Von ihr
 * kamen am 05.11. 112 falsche Titel.
 *
 * Stimmen beide ueberein, ist der Titel sicher. Widersprechen sie sich, wird
 * nicht still entschieden: das Heft bekommt den Vermerk "Titel pruefen" mit
 * beiden Vorschlaegen. Ein Sammelheft (Magazin) hat keinen durchgehenden
 * Kolumnentitel, jeder Artikel seinen eigenen; dort gilt der Aufmacher der
 * Titelseite, wenn der Satz ihn kennt, sonst "Magazin Nr. 7".
 */

import type { TextItem, TextPage } from "./textLayer";
import { gerade, stueckeVerbinden, textZeilen } from "./umschlagTitel";

export type Kolumnentitel = {
  /** Der Kolumnentitel in der haeufigsten Schreibung. */
  text: string;
  /** Auf so vielen Seiten steht er. */
  anzahl: number;
  /** Alle Koepfe des Hefts, haeufigster zuerst (Sammelheft: je Artikel einer). */
  koepfe: { text: string; anzahl: number }[];
};

/** Seitenzahl als eigenes Stueck am Zeilenrand. */
const SEITENZAHL = /^(\d{1,3}|[ivxlc]{1,6})$/i;
/**
 * Schriftzug der Reihe im Kopf gerader Seiten ("10 WELTKRIEG", bei Soldaten
 * "weltkrieg", bei Blitzkrieg "Blitzkrieg"): nur als ganzes Stueck, ein
 * Titel "Blitzkrieg auf dem Balkan" bleibt.
 */
const SCHRIFTZUG = /^(weltkrieg|freikorps|legion|blitzkrieg|magazin)$/i;
/** Druckvermerk im Rand ("7mag Innenteil.indd 42 28.10.15 18:49"). */
const DRUCKVERMERK = /\.indd\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\s+\d{1,2}:\d{2}\b/i;
/** So oft muss eine Kopfzeile stehen, um als Kolumnentitel zu gelten. */
const MINDESTENS = 3;
/**
 * Sammelheft: so viele verschiedene Koepfe, die je mindestens MINDESTENS-mal
 * stehen, jeder Artikel seinen eigenen. Gemessen 05.11.2026 an 436 Heften:
 * Magazin 5 bis 14, alle anderen Reihen hoechstens 3 (Titel plus
 * Infokaesten "Kompakt", "SPEZIAL").
 */
export const SAMMELHEFT_KOEPFE = 4;

export function istSammelheft(k: Kolumnentitel): boolean {
  return k.koepfe.filter((x) => x.anzahl >= MINDESTENS).length >= SAMMELHEFT_KOEPFE;
}

/** Vergleichsform: klein, ß als ss, ohne Satzzeichen und Leerraum. */
export function titelSchluessel(t: string): string {
  return t
    .toLocaleLowerCase("de-DE")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Die Kopfzeile einer Seite: die oberste Zeile ohne Seitenzahl. Steht dort
 * nur der Schriftzug der Reihe (gerade Seiten) oder ein Druckvermerk, hat die
 * Seite keinen Kolumnentitel.
 */
export function kopfzeile(items: TextItem[]): string | null {
  for (const z of textZeilen(items.filter((i) => gerade(i) && i[0].trim()))) {
    const teile = [...z.teile];
    // Die Seitenzahl steht als eigenes Stueck am Rand, nie mitten im Titel
    // ("Orkanböen über U 47" behaelt seine 47).
    while (teile.length && SEITENZAHL.test(teile[0][0].trim())) teile.shift();
    while (teile.length && SEITENZAHL.test(teile[teile.length - 1][0].trim())) teile.pop();
    if (!teile.length) continue; // nur die Seitenzahl: naechste Zeile
    while (teile.length && SCHRIFTZUG.test(teile[0][0].trim())) teile.shift();
    while (teile.length && SCHRIFTZUG.test(teile[teile.length - 1][0].trim())) teile.pop();
    const text = stueckeVerbinden(teile).replace(/\s+/g, " ").trim();
    if (!text || DRUCKVERMERK.test(text)) return null;
    return text;
  }
  return null;
}

/** Der Kolumnentitel des Innenteils, oder null ohne wiederkehrenden Kopf. */
export function kolumnentitel(seiten: TextPage[]): Kolumnentitel | null {
  const zaehler = new Map<string, Map<string, number>>();
  for (const s of seiten) {
    const t = kopfzeile(s.items);
    if (!t) continue;
    const k = titelSchluessel(t);
    if (!k) continue;
    const schreibungen = zaehler.get(k) ?? new Map<string, number>();
    schreibungen.set(t, (schreibungen.get(t) ?? 0) + 1);
    zaehler.set(k, schreibungen);
  }
  const koepfe = [...zaehler.values()]
    .map((schreibungen) => ({
      text: [...schreibungen.entries()].sort((a, b) => b[1] - a[1])[0][0],
      anzahl: [...schreibungen.values()].reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.anzahl - a.anzahl);
  const best = koepfe[0];
  if (!best || best.anzahl < MINDESTENS) return null;
  return { ...best, koepfe: koepfe.slice(0, 20) };
}

export type TitelPruefen = { umschlag?: string; kolumne?: string; grund: string };

export type TitelEntscheid = {
  titel: string;
  quelle: "beide" | "kolumne" | "umschlag" | "nummer";
  pruefen?: TitelPruefen;
};

/** "Weltkrieg Magazin" -> "Magazin": der Name der Reihe ohne die Marke. */
function reiheKurz(reihe: string): string {
  return reihe.replace(/^Weltkrieg\s+/i, "").trim() || reihe;
}

/**
 * Den Titel waehlen. `umschlag` ist der Titel der Titelseite in der
 * Schreibung des Satzes; `umschlagBestaetigt`, wenn der Satz ihn Wort fuer
 * Wort kennt (`schreibungAusSatz` fand ihn), sonst nur aus Versalien geraten.
 */
export function titelEntscheiden(a: {
  umschlag: string | null;
  umschlagBestaetigt: boolean;
  kolumne: Kolumnentitel | null;
  reihe: string;
  nummer?: string | null;
}): TitelEntscheid {
  const u = a.umschlag?.trim() || null;
  const k = a.kolumne;
  const nummer = a.nummer ? `${reiheKurz(a.reihe)} Nr. ${a.nummer}` : reiheKurz(a.reihe);

  // Sammelheft: der Kopf gehoert dem jeweiligen Artikel, nicht dem Heft.
  // Titel ist der Aufmacher der Titelseite, wenn das Heft ihn kennt.
  if (k && istSammelheft(k)) {
    if (u && a.umschlagBestaetigt) return { titel: u, quelle: "umschlag" };
    if (u) {
      // Derselbe Artikel unter umgestellten Woertern ("Zum Westwall zurück"
      // auf dem Umschlag, "Zurück zum Westwall" im Kopf).
      const woerter = (t: string) => t.toLocaleLowerCase("de-DE").replace(/ß/g, "ss").match(/[\p{L}\p{N}]+/gu)?.sort().join(" ") ?? "";
      const gleich = k.koepfe.find((x) => woerter(x.text) === woerter(u));
      return {
        titel: u,
        quelle: "umschlag",
        pruefen: {
          umschlag: u,
          ...(gleich ? { kolumne: gleich.text } : {}),
          grund: "Aufmacher der Titelseite steht so nicht im Heft",
        },
      };
    }
    return { titel: nummer, quelle: "nummer" };
  }

  if (k && u) {
    // Einig: die Schreibung der Titelseite, wenn der Satz sie traegt, sonst
    // die des Kolumnentitels (gesetzt, nicht aus Versalien geraten).
    if (titelSchluessel(k.text) === titelSchluessel(u)) {
      return { titel: a.umschlagBestaetigt ? u : k.text, quelle: "beide" };
    }
    // Beide da, aber verschieden: der bestaetigte Umschlag bleibt vorlaeufig
    // (er ist der gedruckte Titel), sonst der Kolumnentitel.
    return {
      titel: a.umschlagBestaetigt ? u : k.text,
      quelle: a.umschlagBestaetigt ? "umschlag" : "kolumne",
      pruefen: { umschlag: u, kolumne: k.text, grund: "Titelseite und Kolumnentitel weichen ab" },
    };
  }
  if (k) {
    return {
      titel: k.text,
      quelle: "kolumne",
      pruefen: { kolumne: k.text, grund: "Auf der Titelseite kein lesbarer Titel" },
    };
  }
  if (u) {
    return a.umschlagBestaetigt
      ? { titel: u, quelle: "umschlag", pruefen: { umschlag: u, grund: "Im Innenteil kein Kolumnentitel" } }
      : {
          titel: u,
          quelle: "umschlag",
          pruefen: { umschlag: u, grund: "Weder Kolumnentitel noch Satz bestaetigen den Titel" },
        };
  }
  return { titel: nummer, quelle: "nummer", pruefen: { grund: "Kein Titel im Heft gefunden" } };
}
