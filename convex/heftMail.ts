/**
 * Werbemail zu einem neu veroeffentlichten Heft: Betreff, HTML und Text,
 * dazu die Regeln, wann sie hinausgeht und welche Beitraege sie nennt.
 *
 * Reine Funktionen ohne Convex-Bezug. Verschickt wird ueber den Laden
 * (Shop-API `heft_mail`, siehe heftAnkuendigung.ts); der Laden setzt nur
 * Absender, DKIM und die Abmelde-Kopfzeilen dazu. Jede Reihe erscheint in
 * ihrer Hausfarbe mit ihrem Schriftzug, wie auf ihrer Seite im Leser
 * (web/src/lib/reihen.ts).
 */

export type MailReihe = {
  /** Kurzname, wie er in Heftbezeichnungen steht ("DMZ Nr. 170"). */
  kurz: string;
  farbe: string;
  /** Schriftzug fuer weissen Grund, Pfad unter der Leser-Adresse, mit Pixelmassen. */
  logo: string;
  logoBreite: number;
  logoHoehe: number;
};

export const MAIL_REIHEN: Record<string, MailReihe> = {
  zuerst: { kurz: "ZUERST!", farbe: "#c4161c", logo: "/img/zuerst-logo.png", logoBreite: 700, logoHoehe: 190 },
  dmz: { kurz: "DMZ", farbe: "#c4161c", logo: "/img/dmz-logo.png", logoBreite: 257, logoHoehe: 120 },
  "dmz-zeitgeschichte": {
    kurz: "DMZ-ZG",
    farbe: "#27408b",
    logo: "/img/dmz-zeitgeschichte-logo.png",
    logoBreite: 336,
    logoHoehe: 96,
  },
  schwertertraeger: {
    kurz: "Schwerterträger",
    farbe: "#b00a18",
    logo: "/img/schwertertraeger-logo.png",
    logoBreite: 407,
    logoHoehe: 96,
  },
};

/** Fuer Reihen ohne eigenen Eintrag: Verlagsrot und Verlagszeichen. */
const VERLAG: Omit<MailReihe, "kurz"> = {
  farbe: "#d20007",
  logo: "/img/lesen-und-schenken.png",
  logoBreite: 350,
  logoHoehe: 124,
};

const ANBIETER =
  "Lesen & Schenken Verlagsauslieferung und Versandgesellschaft mbH · Voßkumsberg 4 · 24238 Martensrade";

/** Was die Mail ueber das Heft weiss; fuer alle Empfaenger gleich. */
export type HeftMailDaten = {
  /** Adresse des Lesers ohne Schraegstrich am Ende. */
  appUrl: string;
  reiheSlug: string | null;
  reiheName: string;
  /** Anzeige-Titel (Name im Laden, sonst eigener Titel). */
  heftTitel: string;
  /** Heftbezeichnung im Laden: "DMZ Nr. 170", bei ZUERST! der Monat. */
  bezeichnung: string | null;
  untertitel: string | null;
  preisCents: number | null;
  umschlagUrl: string | null;
  /** Detailseite des Hefts im Leser, z. B. "/issue/dmz-170". */
  heftPfad: string;
  themen: Thema[];
  /** Abo-Seite der Reihe, nur wenn es ein Digital-Abo gibt. */
  aboPfad: string | null;
};

export type Thema = { titel: string; unterzeile?: string | null };

/** Was je Empfaenger anders ist. */
export type HeftMailEmpfaenger = {
  /** Das Heft ist schon freigeschaltet (Abo oder Kauf). */
  zugang: boolean;
  /** Seite mit dem Knopf, der genau diese Reihe abbestellt. */
  abmeldenUrl: string;
  /** Seite mit allen Reihen dieser Adresse. */
  einstellungenUrl: string;
};

export type HeftMailInhalt = { betreff: string; vorschau: string; html: string; text: string };

function ohneZeichen(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

export function mailReihe(slug: string | null, name: string): MailReihe {
  return (slug ? MAIL_REIHEN[slug] : undefined) ?? { kurz: name, ...VERLAG };
}

/**
 * Name des Hefts fuer Betreff und Kopf: die Heftbezeichnung des Ladens, mit
 * dem Kurznamen der Reihe davor, wo sie ihn nicht schon traegt
 * ("Dezember 2025" → "ZUERST! Dezember 2025").
 */
export function heftName(d: Pick<HeftMailDaten, "reiheSlug" | "reiheName" | "bezeichnung" | "heftTitel">): string {
  const kurz = mailReihe(d.reiheSlug, d.reiheName).kurz;
  const bez = d.bezeichnung?.trim();
  if (!bez) return d.heftTitel.trim() || kurz;
  const b = ohneZeichen(bez);
  if (b.includes(ohneZeichen(kurz)) || b.includes(ohneZeichen(d.reiheName))) return bez;
  return `${kurz} ${bez}`;
}

/**
 * Titelthema des Hefts ("Fernspäher"), oder null, wenn der Titel nur die
 * Reihe nennt ("ZUERST!", "DMZ 170").
 */
export function heftThema(d: Pick<HeftMailDaten, "reiheSlug" | "reiheName" | "bezeichnung" | "heftTitel">): string | null {
  const t = d.heftTitel.trim();
  if (!t) return null;
  const n = ohneZeichen(t);
  const kurz = ohneZeichen(mailReihe(d.reiheSlug, d.reiheName).kurz);
  if (!n || n.startsWith(kurz) || n.startsWith(ohneZeichen(d.reiheName))) return null;
  if (n === ohneZeichen(heftName(d))) return null;
  return t;
}

/**
 * Rubriken, die in jedem Heft stehen und nichts ueber dieses Heft sagen.
 * Sie fuellen das Inhaltsverzeichnis, aber nicht die Mail.
 */
const RUBRIK =
  /^(editorial|vorwort|impressum|inhalt|leserbriefe?|leserpost|kalenderblatt|historischer kalender|buchbesprechungen?|b[uü]cher|neue b[uü]cher|nachrichten|politikmeldungen|meldungen|kurzmeldungen|vorschau|liebe leser|termine|anzeigen?)\b/i;

/**
 * Beitraege fuer "In diesem Heft": in der Reihenfolge des gedruckten
 * Verzeichnisses, ohne feste Rubriken, ohne das Titelthema (das steht schon
 * oben) und ohne Doppel.
 */
export function themenAuswahl(eintraege: Thema[], titelthema: string | null, max = 5): Thema[] {
  const gesehen = new Set<string>();
  if (titelthema) gesehen.add(ohneZeichen(titelthema));
  const out: Thema[] = [];
  for (const e of eintraege) {
    const titel = e.titel.replace(/\s+/g, " ").trim();
    const schluessel = ohneZeichen(titel);
    if (titel.length < 3 || RUBRIK.test(titel) || gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    const unterzeile = e.unterzeile?.replace(/\s+/g, " ").trim() || null;
    out.push({ titel, unterzeile });
    if (out.length >= max) break;
  }
  return out;
}

// --- Versandzeit ------------------------------------------------------------

const STUNDE = 60 * 60 * 1000;

/** 01:00 UTC am letzten Sonntag des Monats (0 = Januar): dann springt die Uhr. */
function letzterSonntag(jahr: number, monat: number): number {
  const d = new Date(Date.UTC(jahr, monat + 1, 0, 1));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}

/** Abstand der deutschen Uhrzeit zu UTC: Sommerzeit zwei Stunden, sonst eine. */
export function deutscheZeitVersatz(t: number): number {
  const jahr = new Date(t).getUTCFullYear();
  return t >= letzterSonntag(jahr, 2) && t < letzterSonntag(jahr, 9) ? 2 * STUNDE : STUNDE;
}

/**
 * Werbung kommt nicht nachts: faellt `t` zwischen 21 und 8 Uhr deutscher
 * Zeit, geht die Mail um 8 Uhr.
 */
export function versandZeit(t: number, frueh = 8, spaet = 21): number {
  const lokal = new Date(t + deutscheZeitVersatz(t));
  const h = lokal.getUTCHours();
  if (h >= frueh && h < spaet) return t;
  const tag = lokal.getUTCDate() + (h >= spaet ? 1 : 0);
  const ziel = Date.UTC(lokal.getUTCFullYear(), lokal.getUTCMonth(), tag, frueh);
  return ziel - deutscheZeitVersatz(ziel - STUNDE);
}

// --- Mail ------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function euro(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

const SANS = "Arial,Helvetica,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

export function heftMail(d: HeftMailDaten, e: HeftMailEmpfaenger): HeftMailInhalt {
  const reihe = mailReihe(d.reiheSlug, d.reiheName);
  const farbe = reihe.farbe;
  const name = heftName(d);
  const thema = heftThema(d);
  const heftUrl = `${d.appUrl}${d.heftPfad}`;
  const aboUrl = !e.zugang && d.aboPfad ? `${d.appUrl}${d.aboPfad}` : null;
  const reiheUrl = d.reiheSlug ? `${d.appUrl}/zeitschrift/${d.reiheSlug}` : d.appUrl;
  const logoHoehe = 50;
  const logoBreite = Math.round((logoHoehe * reihe.logoBreite) / reihe.logoHoehe);
  const meta = [thema ? name : null, d.untertitel].filter(Boolean).join(" · ");

  // Der Laden nimmt keine spitzen Klammern im Betreff (Validate::isMailSubject).
  const betreff = (thema ? `${name} ist erschienen: ${thema}` : `${name} ist erschienen`).replace(/[<>]/g, "");
  const vorschau = d.themen.length
    ? `In diesem Heft: ${d.themen.map((t) => t.titel).join(" · ")}`
    : "Ab sofort digital zu lesen.";
  const einleitung = e.zugang
    ? `${name} ist erschienen und steht schon in Ihrer Bibliothek bereit.`
    : `${name} ist erschienen und ab sofort digital zu lesen: im Browser auf Rechner, Tablet und Telefon, als Druckseite oder als Lesetext.`;
  const knopf = e.zugang ? "Jetzt lesen" : "Heft ansehen";
  const preis = !e.zugang && d.preisCents ? `Digitalausgabe ${euro(d.preisCents)}` : null;
  const abmelden = "Wenn Sie keine Benachrichtigungen zu dieser Heftreihe erhalten möchten, klicken Sie einfach hier auf";

  const h = escapeHtml;
  const zeile = (inhalt: string, stil: string, attr = "") =>
    `<tr><td class="pad"${attr} style="${stil}">${inhalt}</td></tr>`;

  const umschlag = d.umschlagUrl
    ? zeile(
        `<a href="${h(heftUrl)}" style="text-decoration:none;"><img class="umschlag" src="${h(d.umschlagUrl)}" width="280" alt="${h(`Titelseite ${name}`)}" style="display:block;width:280px;max-width:100%;height:auto;border:0;box-shadow:0 8px 22px rgba(0,0,0,0.22);"></a>`,
        "padding:22px 32px 0 32px;",
        ' align="center"',
      )
    : "";

  const themen = d.themen.length
    ? zeile(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ece7df;">
            <tr><td style="padding:22px 0 6px 0;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#8a857d;">In diesem Heft</td></tr>
            ${d.themen
              .map(
                (t) => `<tr><td style="padding:8px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:3px solid ${farbe};padding:2px 0 2px 14px;">
                <div style="font-family:${SERIF};font-size:17px;line-height:1.35;color:#1d1d1d;">${h(t.titel)}</div>${
                  t.unterzeile
                    ? `
                <div style="font-family:${SANS};font-size:14px;line-height:1.45;color:#6b665e;padding-top:2px;">${h(t.unterzeile)}</div>`
                    : ""
                }
              </td></tr></table>
            </td></tr>`,
              )
              .join("\n            ")}
          </table>`,
        "padding:30px 32px 0 32px;",
      )
    : "";

  const abo = aboUrl
    ? zeile(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f4ef;border-radius:4px;">
            <tr><td style="padding:16px 18px;font-family:${SANS};font-size:14px;line-height:1.5;color:#333;">
              <strong style="color:#1d1d1d;">Kein Heft verpassen</strong><br>
              Mit dem Digital-Abo kommt jede neue Ausgabe von selbst in Ihre Bibliothek.<br>
              <a href="${h(aboUrl)}" style="color:${farbe};font-weight:bold;text-decoration:none;">Digital-Abo ansehen&nbsp;&rsaquo;</a>
            </td></tr>
          </table>`,
        "padding:26px 32px 0 32px;",
      )
    : "";

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${h(betreff)}</title>
<style>
  @media (max-width: 620px) {
    .karte { border-radius: 0 !important; border-left: 0 !important; border-right: 0 !important; }
    .pad { padding-left: 20px !important; padding-right: 20px !important; }
    .umschlag { width: 230px !important; }
    .titel { font-size: 26px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${h(vorschau)}${"&#8199;&#847; ".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ec;">
  <tr>
    <td align="center" style="padding:24px 0;">
      <table role="presentation" class="karte" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e3ddd3;border-radius:6px;">
        <tr><td style="height:5px;line-height:5px;font-size:0;background:${farbe};border-radius:6px 6px 0 0;">&nbsp;</td></tr>
        ${zeile(
          `<a href="${h(reiheUrl)}" style="text-decoration:none;"><img src="${h(d.appUrl + reihe.logo)}" width="${logoBreite}" height="${logoHoehe}" alt="${h(d.reiheName)}" style="display:block;border:0;width:${logoBreite}px;height:${logoHoehe}px;"></a>`,
          "padding:22px 32px 0 32px;",
          ' align="center"',
        )}
        ${umschlag}
        ${zeile("Neu erschienen", `padding:28px 32px 0 32px;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:0.14em;text-transform:uppercase;color:${farbe};`, ' align="center"')}
        <tr><td class="pad titel" align="center" style="padding:8px 32px 0 32px;font-family:${SERIF};font-size:30px;line-height:1.2;color:#1d1d1d;">${h(thema ?? name)}</td></tr>
        ${meta ? zeile(h(meta), `padding:8px 32px 0 32px;font-family:${SANS};font-size:15px;line-height:1.4;color:#6b665e;`, ' align="center"') : ""}
        ${zeile(`Guten Tag,<br><br>${h(einleitung)}`, `padding:26px 32px 0 32px;font-family:${SANS};font-size:15px;line-height:1.55;color:#333333;`)}
        <tr>
          <td align="center" style="padding:24px 32px 0 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:${farbe};border-radius:4px;">
                  <a href="${h(heftUrl)}" style="display:inline-block;padding:14px 34px;font-family:${SANS};font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${knopf}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${preis ? zeile(h(preis), `padding:10px 32px 0 32px;font-family:${SANS};font-size:13px;color:#8a857d;`, ' align="center"') : ""}
        ${themen}
        ${abo}
        <tr><td style="height:32px;line-height:32px;font-size:0;">&nbsp;</td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        ${zeile(
          `Sie erhalten diese E-Mail, weil Sie bei Lesen &amp; Schenken digitale Hefte gekauft haben.<br>
          ${h(abmelden)} <a href="${h(e.abmeldenUrl)}" style="color:#8a857d;text-decoration:underline;">abbestellen</a>.<br>
          <a href="${h(e.einstellungenUrl)}" style="color:#8a857d;text-decoration:underline;">Alle Mail-Einstellungen</a><br><br>
          ${h(ANBIETER).replace(/ (\d)/g, "&nbsp;$1").replace(/(\d) /g, "$1&nbsp;")}<br>
          <a href="${h(d.appUrl)}/impressum" style="color:#8a857d;text-decoration:underline;">Impressum</a>`,
          `padding:20px 32px 8px 32px;font-family:${SANS};font-size:12px;line-height:1.6;color:#8a857d;`,
          ' align="center"',
        )}
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;

  const text = [
    thema ? `${name} ist erschienen: ${thema}` : `${name} ist erschienen`,
    d.untertitel ?? "",
    "",
    "Guten Tag,",
    "",
    einleitung,
    "",
    `${knopf}: ${heftUrl}`,
    preis ?? "",
    ...(d.themen.length
      ? ["", "In diesem Heft:", ...d.themen.map((t) => `– ${t.titel}${t.unterzeile ? `: ${t.unterzeile}` : ""}`)]
      : []),
    ...(aboUrl
      ? ["", "Kein Heft verpassen: Mit dem Digital-Abo kommt jede neue Ausgabe von selbst in Ihre Bibliothek.", aboUrl]
      : []),
    "",
    "-- ",
    "Sie erhalten diese E-Mail, weil Sie bei Lesen & Schenken digitale Hefte gekauft haben.",
    `${abmelden} abbestellen:`,
    e.abmeldenUrl,
    `Alle Mail-Einstellungen: ${e.einstellungenUrl}`,
    "",
    ANBIETER,
    `Impressum: ${d.appUrl}/impressum`,
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return { betreff, vorschau, html, text };
}
