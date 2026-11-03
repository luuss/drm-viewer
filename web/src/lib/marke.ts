/**
 * Marke der Anlage. Derselbe Code laeuft als zwei Leser:
 *
 *   lus        digital.lesenundschenken.de  (Standard)
 *   weltkrieg  digital.weltkrieg-online.de  (docker-compose.weltkrieg.yml)
 *
 * Gewaehlt wird beim Bau ueber `VITE_MARKE`. Alles, was der Leser ueber den
 * Verlag sagt (Name, Logo, Laden, Kontakt, Fuss, Rechtstexte), steht hier;
 * Farben und Schriften der Marke stehen in `styles.css` unter
 * `[data-marke="weltkrieg"]` (main.tsx setzt das Attribut an <html>).
 */
export type MarkeId = "lus" | "weltkrieg";

export type Marke = {
  id: MarkeId;
  /** Name der Anlage, z. B. im Seitentitel. */
  name: string;
  /** Logo fuer die dunkle Kopfleiste und den Fuss. */
  logo: string;
  /** Logo fuer hellen Grund (Anmeldeseite). */
  logoHell: string;
  logoAlt: string;
  /** Logo ist ein breiter Schriftzug (Weltkrieg) statt eines Bildzeichens. */
  logoSchriftzug: boolean;
  /** Startseite des Ladens. */
  laden: string;
  /** Domain des Ladens fuer Fliesstext ("lesenundschenken.de"). */
  ladenDomain: string;
  kontakt: { label: string; text: string; href?: string }[];
  fussTitel: string;
  fussText: string;
  copyright: string;
  /**
   * Rechtstexte: `intern` = eigene Seiten des Lesers (LegalPage), sonst
   * Verweis auf die Seiten des Ladens.
   */
  recht:
    | { intern: true }
    | { intern: false; impressum: string; datenschutz: string; agb: string; widerruf: string };
  /** Kopfbild auf der Startseite (Kiosk), wie im Laden. */
  kopfbild?: { src: string; srcSet: string; breite: number; hoehe: number };
  /** Farbstreifen unter der Kopfleiste, Hausfarben der Reihen. */
  streifen?: string[];
};

const LUS: Marke = {
  id: "lus",
  name: "Lesen & Schenken Digital",
  logo: "/img/lesen-und-schenken.png",
  logoHell: "/img/lesen-und-schenken.png",
  logoAlt: "Lesen und Schenken",
  logoSchriftzug: false,
  laden: "https://lesenundschenken.de/",
  ladenDomain: "lesenundschenken.de",
  kontakt: [
    {
      label: "E-Post",
      text: "bestellung-netzladen@lesenundschenken.de",
      href: "mailto:bestellung-netzladen@lesenundschenken.de",
    },
    { label: "Telefon", text: "04384 5970-0", href: "tel:+49438459700" },
    { label: "Fax", text: "04384 5970-40" },
  ],
  fussTitel: "Lesen & Schenken Digital",
  fussText:
    "Die Zeitschriften des Verlags zum Lesen am Bildschirm. Einzelne Ausgaben und Digital-Abos gibt es im Netzladen, gelesen wird hier auf jedem Gerät.",
  copyright: "Lesen und Schenken GmbH",
  recht: { intern: true },
};

const WK_LADEN = "https://weltkrieg-online.de/";

const WELTKRIEG: Marke = {
  id: "weltkrieg",
  name: "Weltkrieg Digital",
  logo: "/img/wk/weltkrieg-hell.svg",
  logoHell: "/img/wk/weltkrieg-dunkel.svg",
  logoAlt: "Weltkrieg",
  logoSchriftzug: true,
  laden: WK_LADEN,
  ladenDomain: "weltkrieg-online.de",
  kontakt: [
    { label: "Verlag", text: "Histomedia AG" },
    { label: "Anschrift", text: "Bahnhofstrasse 23, 6300 Zug, Schweiz" },
    { label: "Kontakt", text: "Kontaktformular", href: `${WK_LADEN}kontaktformular/` },
  ],
  fussTitel: "Weltkrieg Digital",
  fussText:
    "Erlebnisberichte, E-Books und Hefte von weltkrieg-online.de zum Lesen am Bildschirm. Gekauft wird im Netzladen, gelesen wird hier auf jedem Gerät.",
  copyright: "Histomedia AG",
  recht: {
    intern: false,
    impressum: `${WK_LADEN}impressum/`,
    datenschutz: `${WK_LADEN}datenschutzerklaerung/`,
    agb: `${WK_LADEN}agb/`,
    widerruf: `${WK_LADEN}widerrufsbelehrung/`,
  },
  kopfbild: {
    src: "/img/wk/kopf-1440.jpg",
    srcSet: "/img/wk/kopf-1440.jpg 1440w, /img/wk/kopf.jpg 2246w",
    breite: 2246,
    hoehe: 703,
  },
  // Menueleiste von weltkrieg-online.de: E-Books, Originalband, Doppelband,
  // Grossband, Flieger, Marine, Soldaten, Magazin, Blitzkrieg, Freikorps, Legion
  streifen: [
    "#5b2c83", "#ec6708", "#22a636", "#e40613", "#222a73", "#018ec3",
    "#8a3b2c", "#edcd00", "#ec6708", "#35532d", "#9f862a",
  ],
};

export const MARKE: Marke =
  (import.meta.env.VITE_MARKE as string | undefined) === "weltkrieg" ? WELTKRIEG : LUS;

export const IST_WELTKRIEG = MARKE.id === "weltkrieg";
