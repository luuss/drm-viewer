/**
 * Hefte im ganzen Heftarchiv finden (Weltkrieg, 03.11.2026).
 *
 * Das Archiv ist 300 GB gross und nicht nach Heften gebaut, sondern nach
 * Reihen und Nummernbereichen ("Doppelbände/121-130d/121d Durchbruch Krim
 * 73. ID/Ausgabe/121d Innenteil Durchbruch zur Krim/….pdf"), dazu ein Ordner
 * mit den fuer E-Books vorbereiteten Heften (IDML und PDF). Ein Heft erkennt
 * man am Innenteil: einer Datei mit "Innenteil" im Namen und der Heftkennung
 * davor ("121d", "23 Fk", "53 Sol-Bio"). Sein Ordner ist der oberste Ordner
 * darueber, der mit derselben Nummer beginnt; Nummernbereiche ("121-130d")
 * zaehlen nicht.
 *
 * Gibt es ein Heft mehrfach (Reihenordner und E-Book-Ordner), gewinnt die
 * Fassung mit IDML, sonst die mit PDF. Alte Staende ("ALT-ALT", "alte
 * versionen") bleiben draussen.
 */

import type { ScannedFile } from "./folderScan";
import type { DroppedFolder } from "./folderDrop";

const KENNUNG = /^\s*(\d+)\s*([a-zäöü]{0,10})/i;
// Blitzkrieg-Hefte tragen die Buchstaben vorn ("b1 tanks forward").
const KENNUNG_VORN = /^\s*([a-z]{1,3})(\d+)\b/i;
const BEREICH = /^\s*\d+\s*-\s*\d+/;
const ALT = /(^|\/)\s*(alt-alt|alte versionen[^/]*|alt|alte hefte)(\/|$)/i;

export type ArchivHeft = DroppedFolder & {
  kennung: string;
  mitIdml: boolean;
  mitPdf: boolean;
  /** Ordner des Hefts im Archiv, fuer die Anzeige. */
  pfad: string;
};

/** "121d", "23fk", "53sol", "1legion", "b1": Nummer und Buchstaben, klein. */
export function heftKennung(name: string): string | null {
  const n = name.normalize("NFC");
  const vorn = KENNUNG_VORN.exec(n);
  if (vorn) return (vorn[1] + vorn[2]).toLowerCase();
  const m = KENNUNG.exec(n);
  if (!m) return null;
  return (m[1].replace(/^0+(?=\d)/, "") + m[2]).toLowerCase();
}

function nummerVon(kennung: string): string {
  return /\d+/.exec(kennung)?.[0] ?? "";
}

/** Innenteil: im Dateinamen oder im Namen des Ordners darueber ("1g innenteil, …"). */
function istInnenteil(name: string, eltern: string): boolean {
  if (/innenteil/i.test(name)) return true;
  return /innenteil/i.test(eltern) && !/umschlag/i.test(name);
}

export function hefteImArchiv(files: ScannedFile[]): ArchivHeft[] {
  const pfade = files.map((f) => f.path.normalize("NFC"));
  // 1. Heftordner: ueber jedem Innenteil der oberste Ordner mit derselben
  //    Nummer vorn; Nummernbereiche ("121-130d") zaehlen nicht.
  const heftOrdner = new Map<string, string>(); // Ordner -> Kennung
  for (let n = 0; n < files.length; n++) {
    const pfad = pfade[n];
    if (ALT.test(pfad) || !/\.(pdf|idml)$/i.test(pfad)) continue;
    const teile = pfad.split("/");
    const name = teile[teile.length - 1];
    const eltern = teile[teile.length - 2] ?? "";
    if (!istInnenteil(name, eltern)) continue;
    const ausDatei = heftKennung(name) ?? heftKennung(eltern);
    if (!ausDatei) continue;
    const nummer = nummerVon(ausDatei);
    let oben = -1;
    for (let i = 0; i < teile.length - 1; i++) {
      if (BEREICH.test(teile[i])) continue;
      const k = heftKennung(teile[i]);
      if (k && nummerVon(k) === nummer) {
        oben = i;
        break;
      }
    }
    if (oben < 0) oben = teile.length - 2;
    const ordner = teile.slice(0, oben + 1).join("/");
    if (!heftOrdner.has(ordner)) heftOrdner.set(ordner, heftKennung(teile[oben]) ?? ausDatei);
  }

  // 2. Jede Datei zum tiefsten Heftordner ueber ihr (ein Heft im Bilderordner
  //    eines anderen gehoert sich selbst).
  const inhalt = new Map<string, ScannedFile[]>();
  for (let n = 0; n < files.length; n++) {
    const teile = pfade[n].split("/");
    for (let i = teile.length - 1; i > 0; i--) {
      const ordner = teile.slice(0, i).join("/");
      if (!heftOrdner.has(ordner)) continue;
      const rest = teile.slice(i).join("/");
      if (!ALT.test(rest)) {
        const liste = inhalt.get(ordner) ?? [];
        liste.push({ ...files[n], path: rest });
        inhalt.set(ordner, liste);
      }
      break;
    }
  }

  // 3. Je Kennung die beste Fassung: mit IDML vor nur PDF.
  const jeKennung = new Map<string, ArchivHeft>();
  for (const [ordner, kennung] of heftOrdner) {
    const eigene = inhalt.get(ordner) ?? [];
    const innen = eigene.filter((f) => {
      const t = f.path.split("/");
      return istInnenteil(t[t.length - 1], t[t.length - 2] ?? "");
    });
    const heft: ArchivHeft = {
      kennung,
      folderName: ordner.split("/").pop() ?? kennung,
      files: eigene,
      mitIdml: innen.some((f) => /\.idml$/i.test(f.name)),
      mitPdf: innen.some((f) => /\.pdf$/i.test(f.name)),
      pfad: ordner,
    };
    if (!heft.mitPdf) continue;
    const bisher = jeKennung.get(kennung);
    const besser =
      !bisher ||
      Number(heft.mitIdml) - Number(bisher.mitIdml) > 0 ||
      (heft.mitIdml === bisher.mitIdml && heft.pfad.length < bisher.pfad.length);
    if (besser) jeKennung.set(kennung, heft);
  }
  return [...jeKennung.values()].sort((a, b) =>
    a.kennung.localeCompare(b.kennung, "de", { numeric: true }),
  );
}

/** Ereignis, mit dem das Heftarchiv Hefte in die Importschlange gibt. */
export const HEFTARCHIV_EREIGNIS = "heftarchiv-hefte";

/** Musterhefte fuer den ersten Lauf: je Reihe mit IDML und nur mit PDF. */
export const MUSTERHEFTE = [
  "1d", "166d", "1n", "330n", "1g", "159g", "2f", "121f", "1m", "112m",
  "1fk", "34fk", "1legion", "49legion", "1soldaten", "74soldaten", "b1",
  "121d", "284n", "131g", "98f", "89m", "23fk", "33legion", "53soldaten", "81mag", "101mag",
];
