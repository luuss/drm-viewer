/**
 * Die Zeitschriftenreihen des Verlags mit ihren Schriftzuegen.
 *
 * Zugeordnet wird ueber den Reihennamen; jedes neue Heft einer Reihe bekommt
 * so Logo und Titelschrift von selbst. Die Reihenfolge zaehlt: "DMZ
 * Zeitgeschichte" muss vor der DMZ stehen. `hell` ist der Schriftzug fuer
 * weissen Grund (Kacheln im Kiosk), `dunkel` der fuer die Kopfleiste der
 * Leseansicht. `kasten`: der Schriftzug hat eine eigene Grundflaeche.
 */
import { MARKE } from "./marke";

export type Kontakt = {
  /** Eigene Internetseite; nur wenn sie die Zeitschrift auch zeigt. */
  web?: string;
  /** Ueberschrift ueber der Internetseite, sonst "Internet". */
  webLabel?: string;
  /** Bild der Internetseite (Screenshot oder Werbegrafik) fuer ihre Kachel. */
  webBild?: string;
  mails: { label: string; adresse: string }[];
  tel: string;
  social: { name: string; url: string }[];
};

export type Reihe = {
  slug: string;
  match: RegExp;
  name: string;
  untertitel: string;
  alt: string;
  hell: string;
  dunkel: string;
  /** Nur der Reihenname ohne Marke darueber ("DOPPELBAND"), fuer Kacheln. */
  nurName?: string;
  kasten: boolean;
  /** Hausfarbe der Reihe fuer ihre eigene Seite. */
  farbe: string;
  /**
   * Woran die Reihe auf der Titelseite zu erkennen ist, wenn nicht am Namen
   * (der Schriftzug "Freikorps" ist ein Bild, im Text steht "Erlebte
   * Geschichte · Freiwillige Wehrverbände"). Weltkrieg-Import.
   */
  umschlag?: RegExp;
  /** Kategorie der Reihe im Netzladen (Druckhefte, Sonderhefte). */
  laden: string;
  /** Werbegrafik fuer die Netzladen-Kachel; ohne sie zeigt die Kachel die neuesten Umschlaege. */
  ladenBild?: string;
  kontakt: Kontakt;
};

// Telefon des Verlags, wie im Impressum aller Hefte.
const VERLAG_TEL = "04384 59 70-0";

const LUS_REIHEN: Reihe[] = [
  {
    slug: "zuerst",
    name: "ZUERST!",
    untertitel: "",
    farbe: "#c4161c",
    laden: "https://lesenundschenken.de/1327-zuerst",
    kontakt: {
      web: "https://zuerst.de",
      webLabel: "Nachrichtenseite",
      webBild: "/img/zuerst-web.jpg",
      mails: [
        { label: "Redaktion", adresse: "redaktion@zuerst.de" },
        { label: "Verlag", adresse: "verlag@zuerst.de" },
      ],
      tel: VERLAG_TEL,
      social: [
        { name: "Telegram", url: "https://t.me/zuerst_magazin" },
        { name: "Facebook", url: "https://www.facebook.com/ZUERST.Magazin/" },
        { name: "Instagram", url: "https://www.instagram.com/zuerst_nachrichtenmagazin/" },
        { name: "X", url: "https://x.com/zuerst_magazin" },
      ],
    },
    match: /^zuerst/i,
    alt: "ZUERST! Deutsches Nachrichtenmagazin",
    hell: "/img/zuerst-logo.png",
    dunkel: "/img/zuerst-logo-dunkel.png",
    kasten: false,
  },
  {
    slug: "dmz-zeitgeschichte",
    name: "DMZ Zeitgeschichte",
    untertitel: "",
    farbe: "#27408b",
    laden: "https://lesenundschenken.de/1329-dmz-zeitgeschichte",
    // dmz-zeitgeschichte.de zeigt derzeit fremden Inhalt (Stand 05.10.2026).
    kontakt: {
      mails: [{ label: "Verlag", adresse: "verlag@deutschemilitaerzeitschrift.de" }],
      tel: VERLAG_TEL,
      social: [],
    },
    match: /zeitgeschichte/i,
    alt: "DMZ Zeitgeschichte",
    hell: "/img/dmz-zeitgeschichte-logo.png",
    dunkel: "/img/dmz-zeitgeschichte-logo.png",
    kasten: true,
  },
  {
    slug: "dmz",
    name: "Deutsche Militärzeitschrift",
    untertitel: "",
    farbe: "#c4161c",
    laden: "https://lesenundschenken.de/1328-dmz",
    // deutschemilitaerzeitschrift.de zeigt derzeit fremden Inhalt (Stand 05.10.2026).
    kontakt: {
      mails: [
        { label: "Redaktion", adresse: "redaktion@deutschemilitaerzeitschrift.de" },
        { label: "Verlag", adresse: "verlag@deutschemilitaerzeitschrift.de" },
      ],
      tel: VERLAG_TEL,
      social: [],
    },
    match: /^(dmz|deutsche milit)/i,
    alt: "Deutsche Militärzeitschrift",
    hell: "/img/dmz-logo.png",
    dunkel: "/img/dmz-logo.png",
    kasten: true,
  },
  {
    slug: "schwertertraeger",
    name: "Schwerterträger",
    untertitel: "",
    farbe: "#b00a18",
    laden: "https://lesenundschenken.de/1330-schwertertrager",
    // schwertertraeger.de zeigt derzeit fremden Inhalt (Stand 05.10.2026).
    kontakt: {
      mails: [{ label: "Verlag", adresse: "verlag@deutschemilitaerzeitschrift.de" }],
      tel: VERLAG_TEL,
      social: [],
    },
    match: /schwertertr/i,
    alt: "Schwerterträger",
    hell: "/img/schwertertraeger-logo.png",
    dunkel: "/img/schwertertraeger-logo.png",
    kasten: true,
  },
];

// Marke Weltkrieg (digital.weltkrieg-online.de): die Reihen aus der Menueleiste
// von weltkrieg-online.de, gleiche Farben, Laden = Kategorie dort.
// Schriftzuege: tools/marke/wk_schriftzuege.py.
const WK = "https://weltkrieg-online.de/produkt-kategorie/";
const WK_KONTAKT: Kontakt = {
  web: "https://weltkrieg-online.de/",
  webLabel: "Netzladen",
  webBild: "/img/wk/kopf-1440.webp",
  mails: [],
  tel: "",
  social: [],
};
function wk(slug: string, name: string, farbe: string, match: RegExp, kategorie: string): Reihe {
  return {
    slug,
    name,
    untertitel: "",
    farbe,
    laden: `${WK}${kategorie}/`,
    kontakt: WK_KONTAKT,
    match,
    alt: name,
    hell: `/img/wk/reihe-${slug}.svg`,
    dunkel: `/img/wk/reihe-${slug}.svg`,
    nurName: `/img/wk/reihe-${slug}-name.svg`,
    kasten: false,
  };
}
const WK_REIHEN: Reihe[] = [
  wk("originalband", "Weltkrieg Originalband", "#ec6708", /original/i, "weltkrieg-originalband"),
  wk("doppelband", "Weltkrieg Doppelband", "#22a636", /doppel/i, "weltkrieg-doppelband"),
  wk("grossband", "Weltkrieg Großband", "#e40613", /gro(ss|ß)band/i, "weltkrieg-grossband"),
  wk("flieger", "Weltkrieg Flieger", "#222a73", /flieger/i, "weltkrieg-flieger"),
  wk("marine", "Weltkrieg Marine", "#018ec3", /marine/i, "weltkrieg-marine"),
  wk("soldaten", "Weltkrieg Soldaten", "#8a3b2c", /soldaten/i, "weltkrieg-soldaten"),
  wk("magazin", "Weltkrieg Magazin", "#edcd00", /magazin/i, "weltkrieg-magazin"),
  { ...wk("blitzkrieg", "Blitzkrieg", "#ec6708", /blitzkrieg/i, "blitzkrieg"), umschlag: /blitzkrieg|second world war in fight/i },
  { ...wk("freikorps", "Freikorps", "#35532d", /freikorps/i, "freikorps"), umschlag: /freikorps|erlebte geschichte|freiwillige wehrverb/i },
  wk("legion", "Legion", "#9f862a", /legion/i, "legion"),
];

export const REIHEN: Reihe[] = MARKE.id === "weltkrieg" ? WK_REIHEN : LUS_REIHEN;

/** Reihenfolge der Kacheln im Kiosk. */
export const REIHENFOLGE =
  MARKE.id === "weltkrieg"
    ? WK_REIHEN.map((r) => r.slug)
    : ["zuerst", "dmz", "dmz-zeitgeschichte", "schwertertraeger"];

export function reiheMitSlug(slug: string | undefined): Reihe | null {
  return REIHEN.find((r) => r.slug === slug) ?? null;
}

export function reiheVon(publicationName: string | null | undefined): Reihe | null {
  const name = publicationName ?? "";
  return REIHEN.find((r) => r.match.test(name)) ?? null;
}

/** Schluessel einer Reihe fuer Filter und Adresse; ohne Logo der Name selbst. */
export function reihenSchluessel(publicationName: string | null | undefined): string {
  return reiheVon(publicationName)?.slug ?? (publicationName ?? "").toLowerCase();
}
