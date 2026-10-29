/**
 * Die Zeitschriftenreihen des Verlags mit ihren Schriftzuegen.
 *
 * Zugeordnet wird ueber den Reihennamen; jedes neue Heft einer Reihe bekommt
 * so Logo und Titelschrift von selbst. Die Reihenfolge zaehlt: "DMZ
 * Zeitgeschichte" muss vor der DMZ stehen. `hell` ist der Schriftzug fuer
 * weissen Grund (Kacheln im Kiosk), `dunkel` der fuer die Kopfleiste der
 * Leseansicht. `kasten`: der Schriftzug hat eine eigene Grundflaeche.
 */
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
  kasten: boolean;
  /** Hausfarbe der Reihe fuer ihre eigene Seite. */
  farbe: string;
  /** Kategorie der Reihe im Netzladen (Druckhefte, Sonderhefte). */
  laden: string;
  /** Werbegrafik fuer die Netzladen-Kachel; ohne sie zeigt die Kachel die neuesten Umschlaege. */
  ladenBild?: string;
  kontakt: Kontakt;
};

// Telefon des Verlags, wie im Impressum aller Hefte.
const VERLAG_TEL = "04384 59 70-0";

export const REIHEN: Reihe[] = [
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

/** Reihenfolge der Kacheln im Kiosk. */
export const REIHENFOLGE = ["zuerst", "dmz", "dmz-zeitgeschichte", "schwertertraeger"];

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
