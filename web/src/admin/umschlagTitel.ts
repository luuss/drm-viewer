/**
 * Titel und Reihe eines Hefts von seiner Titelseite (Weltkrieg-Leser).
 *
 * Die Ordnernamen der Druckvorstufe tragen weder die Reihe noch zuverlaessig
 * den Titel ("159d Sturm zum Finnenmeer-Baltikum 1941"). Die Titelseite schon:
 * oben der Schriftzug, darunter in der groessten Schrift der Titel, und die
 * Reihe steht als Wort dabei ("erlebnisberichte – Doppelband"). Der Buchstabe
 * hinter der Nummer ist kein Beleg fuer die Reihe; es zaehlt, was gedruckt ist.
 *
 * Nur die Titelseite (U1) wird gelesen. Auf U4 stehen Anzeigen fuer andere
 * Reihen ("FREIKORPS behandelt …").
 */

import type { TextItem } from "./textLayer";

/**
 * Der Kopf der Titelseite: Schriftzug und Reihenzeile beginnen ganz oben,
 * darunter stehen Nummer, Preis und Internetadresse. Der Kopf endet, wo sein
 * letztes Stueck endet, gemessen auf jeder Titelseite; der Titel steht
 * darunter (Mitte der Zeile unter dem Kopf). Bis 05.11.2026 galt fest alles
 * oberhalb von 22 % der Seite als Kopf, und bei 49 Heften fiel die erste
 * Titelzeile weg („GENERAL-“ von „General-Stäbler“ Sander, Originalband 327,
 * begann bei 21,8 %).
 */
const KOPF_OBEN = 0.05;
/** Unterhalb davon ist nichts mehr Kopf. */
const KOPF_HOECHSTENS = 0.3;
/** Schmaler ist kein Text der Titelseite, sondern ein Rest am Bund ("2o26"). */
const KOPF_MIN_BREITE = 0.02;
/** Nummer, Preis, Adresse: "Nr. 327", "NO. 35", "€ 4,45", "www.weltkrieg.info". */
const ANGABE = /^(n[ro]\.?\s*\d+\s*$|www\.|€|chf\b|\d+,\d\d\b)|weltkrieg\.info|\bn[ro]\.\s*\d+$/i;
/** Die Schriftzuege der Anlage, auch tiefer gesetzt (fruehe Magazin-Titel). */
const SCHRIFTZUG = /^(weltkrieg|magazin)$/i;
/** Kleiner als diese Schrift ist kein Titel mehr, sondern Unterzeile. */
const TITEL_MINDESTGROESSE = 20;
/** Zeilen gleicher Groesse (auf diese Spanne) gehoeren zum selben Titel. */
const GROESSEN_SPANNE = 0.12;
/**
 * Eine Zeile direkt ueber oder unter dem Titel in etwas kleinerer Schrift
 * gehoert dazu (Dienstgrad ueber dem Namen, "Krieg / nach dem Krieg"):
 * mindestens dieser Anteil der Titelschrift, Abstand hoechstens ABSTAND.
 */
const BLOCK_GROESSE = 0.75;
const BLOCK_ABSTAND = 0.02;

export type UmschlagName = {
  /** Titel wie gedruckt, in Versalien auf dem Umschlag. */
  titelGedruckt: string;
  /** Name der Reihe, wie ihn die Liste der Anlage fuehrt. */
  reihe: string | null;
};

type Reihe = { name: string; match: RegExp; umschlag?: RegExp };

/** Der Kopf der Titelseite: Reihenzeile und Schriftzug. */
const REIHE_IM_KOPF = 0.3;

function gerade(i: TextItem): boolean {
  return i.length < 7 || !i[6] || i[6] % 360 === 0;
}

/**
 * Derselbe Text an derselben Stelle zaehlt einmal: Titel liegen oft doppelt
 * im PDF, einmal als Kontur ("Blutiger Januar Blutiger Januar").
 */
function ohneDoppel(items: TextItem[]): TextItem[] {
  const gesehen = new Set<string>();
  return items.filter((i) => {
    const k = `${i[0].trim()}|${Math.round(i[1] * 100)}|${Math.round(i[2] * 100)}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
}

/** Unterkante des Kopfs (Anteil der Seitenhoehe). */
function kopfEnde(items: TextItem[]): number {
  let ende = 0;
  for (const i of items) {
    const t = i[0].trim();
    // Schmale Streifen am Rand ("2o26" 0,7 % breit ueber ein Drittel der
    // Hoehe, Marine 106) sind kein Kopf, sondern Reste am Bund.
    if (i[2] >= KOPF_HOECHSTENS || i[3] - i[1] < KOPF_MIN_BREITE) continue;
    if (i[2] < KOPF_OBEN || ANGABE.test(t) || SCHRIFTZUG.test(t)) ende = Math.max(ende, i[4]);
  }
  return ende;
}

type Zeile = { text: string; oben: number; unten: number; groesse: number };

/**
 * Stuecke einer Zeile verbinden. Zierschriften liefern ein Wort in Stuecken
 * ("b" "ombenk" "R" "ieg", Doppelband 137); stossen sie ohne Luecke
 * aneinander, ist es ein Wort.
 */
function zeilen(items: TextItem[]): Zeile[] {
  const sortiert = [...items].sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  const out: { teile: TextItem[]; oben: number; unten: number }[] = [];
  for (const i of sortiert) {
    const hoehe = i[4] - i[2];
    const z = out.find((x) => Math.abs(x.oben - i[2]) < hoehe * 0.25 && Math.abs(x.unten - i[4]) < hoehe * 0.25);
    if (z) z.teile.push(i);
    else out.push({ teile: [i], oben: i[2], unten: i[4] });
  }
  return out.map((z) => {
    const teile = z.teile.sort((a, b) => a[1] - b[1]);
    let text = "";
    let rechts = -1;
    for (const t of teile) {
      const luecke = t[1] - rechts;
      const dicht = rechts >= 0 && luecke < (t[4] - t[2]) * 0.15;
      text += (text && !dicht ? " " : "") + t[0].trim();
      rechts = t[3];
    }
    return { text, oben: z.oben, unten: z.unten, groesse: Math.max(...teile.map((t) => t[5])) };
  });
}

/** Zeilen verbinden; ein Trennstrich am Zeilenende verbindet ohne Luecke. */
function zeilenVerbinden(zeilen: string[]): string {
  let out = "";
  for (const z of zeilen) {
    if (!out) out = z;
    // Auch nach einem Anfuehrungszeichen: „TOTEN“- / BRIGADE (Magazin 88).
    else if (/[\p{L}“”"’]-$/u.test(out)) out += z;
    else out += " " + z;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Die Titelzeilen: die groesste Schrift unter dem Kopf und der Block um sie. */
function titelZeilen(flach: TextItem[]): string[] {
  const kopf = kopfEnde(flach);
  const alle = zeilen(
    flach.filter(
      (i) =>
        (i[2] + i[4]) / 2 > kopf &&
        i[3] - i[1] >= KOPF_MIN_BREITE &&
        !SCHRIFTZUG.test(i[0].trim()),
    ),
  );
  const groesste = Math.max(0, ...alle.map((z) => z.groesse));
  if (groesste < TITEL_MINDESTGROESSE) return [];
  const kern = alle.filter((z) => z.groesse >= groesste * (1 - GROESSEN_SPANNE));
  // Der Titel ist der Block um die erste Zeile in groesster Schrift.
  const block = [kern[0]];
  let wuchs = true;
  while (wuchs) {
    wuchs = false;
    for (const z of alle) {
      if (block.includes(z)) continue;
      const passt = z.groesse >= groesste * (kern.includes(z) ? 1 - GROESSEN_SPANNE : BLOCK_GROESSE);
      const nah = block.some((b) => z.oben - b.unten <= BLOCK_ABSTAND && b.oben - z.unten <= BLOCK_ABSTAND);
      if (passt && nah) {
        block.push(z);
        wuchs = true;
      }
    }
  }
  // Weitere Zeilen in Titelschrift anderswo auf der Seite gehoeren auch dazu
  // (frueheres Verhalten: alle Zeilen der groessten Schrift).
  for (const z of kern) if (!block.includes(z)) block.push(z);
  return block.sort((a, b) => a.oben - b.oben).map((z) => z.text);
}

export function nameVomUmschlag(items: TextItem[], reihen: Reihe[]): UmschlagName | null {
  const flach = ohneDoppel(items.filter((i) => gerade(i) && i[0].trim()));
  const titelGedruckt = zeilenVerbinden(titelZeilen(flach));
  // Die Reihe steht in der Zeile ganz oben ("erlebnisberichte – Grossband");
  // erst dort suchen, dann im Kopf, dann auf der ganzen Seite. Bis 05.11.2026
  // zuerst im ganzen Kopf: "DOPPELSCHUSS ROT" (Grossband 147) passte auf
  // Doppelband, weil der vor Grossband in der Liste steht. Der Schriftzug der
  // Anlage ("WELTKRIEG") passt auf keine Reihe; steht keine da, bleibt es offen.
  const zeile = flach.filter((i) => i[2] < KOPF_OBEN).map((i) => i[0]).join(" ");
  const kopf = flach.filter((i) => i[2] < REIHE_IM_KOPF).map((i) => i[0]).join(" ");
  const text = flach.map((i) => i[0]).join(" ");
  const passt = (r: Reihe, t: string) => (r.umschlag ?? r.match).test(t);
  const reihe =
    (reihen.find((r) => passt(r, zeile)) ??
      reihen.find((r) => passt(r, kopf)) ??
      reihen.find((r) => passt(r, text)))?.name ?? null;
  if (!titelGedruckt && !reihe) return null;
  return { titelGedruckt, reihe };
}

/**
 * Der Titel in der Schreibung des Satzes. Der Umschlag setzt Versalien;
 * im Innenteil steht derselbe Titel meist richtig geschrieben ("Der lange
 * Schatten der Vergangenheit"). Verglichen wird Wort fuer Wort, ohne
 * Ruecksicht auf Gross- und Kleinschreibung, Satzzeichen und Zeilenumbrueche;
 * die Woerter kommen aus dem Satz, die Satzzeichen bleiben die des Umschlags
 * („DAS ALLES WEGEN ZWEIER BRÜCKEN!“ und im Satz „Das alles wegen zweier
 * Brücken…“ ergibt „Das alles wegen zweier Brücken!“). Versal-SS darf im
 * Satz ß sein (THEISS, Theiß), eine Null im Wort ein O (R0T, Rot). Ein Bindestrich im Wort kann eine Trennung am
 * Zeilenende des Umschlags sein ("OBERST-" / "LEUTNANT"): der Satz
 * entscheidet ("Oberstleutnant", aber "General-Stäbler").
 */
export function schreibungAusSatz(titel: string, satzTexte: string[]): string | null {
  const teile = titel.trim().split(/([\p{L}\p{N}]+)/u);
  // teile: [vor, wort, zwischen, wort, …, nach]
  const woerter = teile.filter((_, i) => i % 2 === 1);
  if (woerter.length === 0) return null;
  // Eine Null zwischen Buchstaben kann ein O der Zierschrift sein ("R0T",
  // Grossband 147, im Satz "Rot").
  const esc = (w: string) =>
    w
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/ss/gi, "(?:ss|ß)")
      .replace(/(?<=\p{L})0|0(?=\p{L})/gu, "[0o]");
  let muster = "";
  for (let i = 0; i < woerter.length; i++) {
    if (i > 0) {
      const zwischen = teile[2 * i];
      // Nur ein Bindestrich zwischen zwei Woertern: vielleicht Trennung, im
      // Satz darf dort nichts stehen.
      muster += /^[-\u00ad]$/.test(zwischen) ? "([^\\p{L}\\p{N}]*)" : "([^\\p{L}\\p{N}]+)";
    }
    muster += `(${esc(woerter[i])})`;
  }
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${muster}(?![\\p{L}\\p{N}])`, "giu");
  // Ein Fund mitten im Fliesstext beginnt klein ("die vergessene Front"); ein
  // Titel im Satz beginnt gross. Der erste solche Fund zaehlt, sonst der
  // erste Fund mit grossem Anfang.
  let ersatz: string | null = null;
  for (const text of satzTexte) {
    for (const fund of text.matchAll(re)) {
      // Gruppen: wort0, (zwischen1, wort1), …
      const satzWort = (i: number) => fund[i === 0 ? 1 : 2 * i + 1];
      const satzZwischen = (i: number) => fund[2 * i];
      const gefunden = woerter.map((_, i) => satzWort(i));
      // Nur eine echte andere Schreibung zaehlt, nicht dieselben Versalien.
      if (gefunden.every((w) => w === w.toUpperCase())) continue;
      let out = teile[0];
      for (let i = 0; i < woerter.length; i++) {
        if (i > 0) {
          const zw = teile[2 * i];
          const imSatz = satzZwischen(i);
          // Trennstrich des Umschlags: steht im Satz nichts oder eine Trennung
          // am Zeilenende vor kleinem Buchstaben ("Oberst-\nleutnant"), ist
          // es ein Wort.
          const getrennt =
            /^[-\u00ad]$/.test(zw) &&
            (imSatz === "" || (/^[-\u00ad]\s+$/.test(imSatz) && /^\p{Ll}/u.test(satzWort(i))));
          // Zeilenumbruch auf dem Umschlag, Bindestrich im Satz
          // ("HERMANN" / "HEINRICH", "Hermann-Heinrich"): der Satz gilt.
          const strich = /^\s+$/.test(zw) && imSatz === "-";
          out += getrennt ? "" : strich ? "-" : zw;
        }
        out += satzWort(i);
      }
      const ergebnis = (out + teile[teile.length - 1]).replace(/\s+/g, " ").trim();
      if (!/^\p{Ll}/u.test(satzWort(0))) return ergebnis;
      ersatz ??= ergebnis.replace(/^(\P{L}*)(\p{Ll})/u, (_, vor, c) => vor + c.toLocaleUpperCase("de-DE"));
    }
  }
  return ersatz;
}

/** Kleine Woerter, die im Titel klein bleiben (ausser am Anfang). */
const KLEIN = new Set(
  ("der die das des dem den ein eine einer eines einem einen und oder auf aus " +
    "bei bis durch fuer für gegen im in ins am an vom von vor zu zum zur mit nach " +
    "ueber über unter um wie als ohne zwischen hinter neben").split(" "),
);

/**
 * Ohne Fund im Satz: aus Versalien einen lesbaren Titel. Hauptwoerter kennt
 * die Regel nicht; darum gross, ausser den kleinen Woertern ("Alles auf eine
 * Karte"). Ein Adjektiv steht dann falsch gross, das ist der kleinere Fehler.
 */
export function ausVersalien(titel: string): string {
  // Zierschriften legen Versalien teils als Kleinbuchstaben ab
  // ("bombenkRieg in deR bocage", Doppelband 137; "MÁTRa", Doppelband 156):
  // ein Grossbuchstabe nach einem kleinen oder ein kleiner nach zwei grossen
  // im selben Wort heisst, der Titel ist in Versalien gesetzt.
  if (/\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}/u.test(titel)) titel = titel.toLocaleUpperCase("de-DE");
  if (titel !== titel.toUpperCase()) return titel;
  return titel
    .toLocaleLowerCase("de-DE")
    .split(/(\s+|-)/)
    .map((wort, i) => {
      if (i > 0 && KLEIN.has(wort)) return wort;
      // Anfuehrungszeichen vorn: der erste Buchstabe danach ("„Windhunde“").
      const m = /^([„"‚'»«(]*)(.*)$/.exec(wort)!;
      return m[1] + m[2].charAt(0).toLocaleUpperCase("de-DE") + m[2].slice(1);
    })
    .join("");
}
