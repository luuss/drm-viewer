/**
 * Einen Heftordner der Druckvorstufe lesen.
 *
 * Die Ordner kommen immer im selben Zuschnitt: ein Innenteil-PDF, die
 * Titelseite als JPG und als TIF, der IDML-Export, die INDD als Archiv,
 * daneben `Links/` mit den platzierten Bildern und `Document fonts/` mit den
 * Schriften. Der groesste Teil davon gehoert nicht auf den Server: die
 * Originalbilder in `Links/` machen allein ueber ein Gigabyte aus, die
 * Schriften sind fuer das Lesen ohne Belang.
 *
 * Dieses Modul entscheidet nur, was welche Rolle hat. Es fasst keine Datei an
 * und spricht mit keinem Server — deshalb laesst es sich ohne Browser pruefen.
 */

export type ScannedFile = {
  /** Pfad im Ordner, mit `/` getrennt, ohne den Ordnernamen selbst. */
  path: string;
  name: string;
  size: number;
  file: File;
};

export type PlanRole =
  | "inner"        // Innenteil-PDF
  | "cover"        // Umschlag-PDF, falls es eins gibt
  | "coverImage"   // Titelseite als Bild
  | "idml"         // Satzdatei
  | "indd"         // Archiv, wird nicht hochgeladen
  | "artwork"      // platziertes Bild aus Links/
  | "ignored";     // Schriften, Systemdateien, nicht lesbare Formate

export type PlanEntry = {
  role: PlanRole;
  file: ScannedFile;
  /** Warum die Datei uebergangen wird. Nur bei `ignored` und `indd` gesetzt. */
  reason?: string;
};

export type FolderPlan = {
  folderName: string;
  entries: PlanEntry[];
  inner?: ScannedFile;
  cover?: ScannedFile;
  coverImage?: ScannedFile;
  idml?: ScannedFile;
  indd: ScannedFile[];
  artwork: ScannedFile[];
  ignored: PlanEntry[];
  /** Summe aller Dateien im Ordner. */
  totalBytes: number;
  /** Summe der Dateien, die unveraendert hochgeladen werden. */
  uploadBytes: number;
  problems: string[];
};

const BILD_ENDUNGEN = [".tif", ".tiff", ".jpg", ".jpeg", ".png"];

function endetAuf(name: string, endungen: string[]): boolean {
  const lower = name.toLowerCase();
  return endungen.some((e) => lower.endsWith(e));
}

function istSystemdatei(name: string): boolean {
  return name === ".DS_Store" || name.startsWith("._") || name === "Thumbs.db";
}

/** Ordnerteile des Pfades ohne den Dateinamen. */
function ordner(path: string): string[] {
  const teile = path.split("/");
  teile.pop();
  return teile;
}

/**
 * Rollen verteilen. Mehrdeutige Faelle entscheidet der Dateiname: ein PDF mit
 * "innen" ist der Innenteil, eins mit "umschlag" oder "titel" der Umschlag.
 * Gibt es nur ein PDF, ist es der Innenteil.
 */
export function classifyFolder(folderName: string, files: ScannedFile[]): FolderPlan {
  const entries: PlanEntry[] = [];
  const pdfs: ScannedFile[] = [];
  const bilderOben: ScannedFile[] = [];
  const artwork: ScannedFile[] = [];
  const indd: ScannedFile[] = [];
  let idml: ScannedFile | undefined;

  for (const f of files) {
    const teile = ordner(f.path).map((t) => t.toLowerCase());
    const name = f.name.toLowerCase();

    if (istSystemdatei(f.name)) {
      entries.push({ role: "ignored", file: f, reason: "Systemdatei" });
      continue;
    }
    if (teile.some((t) => t.includes("document fonts") || t === "fonts")) {
      entries.push({ role: "ignored", file: f, reason: "Schrift" });
      continue;
    }
    if (teile.some((t) => t === "links")) {
      if (endetAuf(name, BILD_ENDUNGEN)) {
        artwork.push(f);
        entries.push({ role: "artwork", file: f });
      } else {
        entries.push({
          role: "ignored",
          file: f,
          reason: "Kein lesbares Bildformat",
        });
      }
      continue;
    }
    if (teile.length > 0) {
      entries.push({ role: "ignored", file: f, reason: "Unbekannter Unterordner" });
      continue;
    }
    if (name.endsWith(".pdf")) {
      pdfs.push(f);
      continue;
    }
    if (name.endsWith(".idml")) {
      // Mehrere Satzdateien: die groesste gewinnt, sie hat den Innenteil.
      if (!idml || f.size > idml.size) {
        if (idml) entries.push({ role: "ignored", file: idml, reason: "Zweite Satzdatei" });
        idml = f;
      } else {
        entries.push({ role: "ignored", file: f, reason: "Zweite Satzdatei" });
      }
      continue;
    }
    if (name.endsWith(".indd")) {
      indd.push(f);
      entries.push({
        role: "indd",
        file: f,
        reason: "Archivdatei, wird nicht ausgewertet",
      });
      continue;
    }
    if (endetAuf(name, BILD_ENDUNGEN)) {
      bilderOben.push(f);
      continue;
    }
    entries.push({ role: "ignored", file: f, reason: "Nicht gebraucht" });
  }

  let inner: ScannedFile | undefined;
  let cover: ScannedFile | undefined;
  for (const f of pdfs) {
    const n = f.name.toLowerCase();
    if (/umschlag|cover|\bu1\b/.test(n) || (/titel/.test(n) && !/innen/.test(n))) {
      cover = cover ?? f;
    } else {
      inner = inner ?? f;
    }
  }
  if (!inner && cover && pdfs.length === 1) {
    inner = cover;
    cover = undefined;
  }
  if (!inner && pdfs.length > 0) inner = pdfs[0];
  for (const f of pdfs) {
    if (f === inner) entries.push({ role: "inner", file: f });
    else if (f === cover) entries.push({ role: "cover", file: f });
    else entries.push({ role: "ignored", file: f, reason: "Drittes PDF" });
  }
  if (idml) entries.push({ role: "idml", file: idml });

  // Titelseite: die TIF ist die bessere Vorlage, die JPG liegt meist nur in
  // Bildschirmgroesse daneben. Umgewandelt wird ohnehin im Browser.
  let coverImage: ScannedFile | undefined;
  const tif = bilderOben.find((f) => endetAuf(f.name, [".tif", ".tiff"]));
  coverImage = tif ?? bilderOben[0];
  for (const f of bilderOben) {
    if (f === coverImage) entries.push({ role: "coverImage", file: f });
    else
      entries.push({
        role: "ignored",
        file: f,
        reason: "Zweite Fassung der Titelseite",
      });
  }

  const problems: string[] = [];
  if (!inner) problems.push("Kein Innenteil-PDF gefunden");
  if (!idml) problems.push("Keine IDML im Ordner — die Artikelerkennung wird ungenauer");
  if (!cover && !coverImage) problems.push("Weder Umschlag-PDF noch Titelseite gefunden");

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const uploadBytes =
    (inner?.size ?? 0) + (cover?.size ?? 0) + (idml?.size ?? 0);

  return {
    folderName,
    entries,
    inner,
    cover,
    coverImage,
    idml,
    indd,
    artwork,
    ignored: entries.filter((e) => e.role === "ignored"),
    totalBytes,
    uploadBytes,
    problems,
  };
}

export type ParsedName = {
  publicationName: string;
  publicationSlug: string;
  issueNumber?: string;
  /** Was im Ordnernamen hinter der Heftnummer steht, etwa "Greim". */
  issueSubtitle?: string;
  issueTitle: string;
};

/**
 * Titel des Hefts. Steht im Ordnernamen ein Zusatz, ist er der Titel; sonst
 * Reihe und Nummer. Der Name der Reihe kommt von aussen, weil eine bekannte
 * Reihe unter ihrem gepflegten Namen steht und nicht unter dem, was zufaellig
 * im Ordnernamen abgekuerzt ist.
 */
export function issueTitleFor(
  parsed: ParsedName,
  publicationName: string,
): string {
  if (parsed.issueSubtitle) return parsed.issueSubtitle;
  return parsed.issueNumber
    ? `${publicationName} ${parsed.issueNumber}`
    : publicationName;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function grossAnfang(s: string): string {
  return s.replace(/(^|[\s-])([a-zäöü])/g, (_m, a, b) => a + b.toUpperCase());
}

/**
 * Reihe und Heftnummer aus dem Ordnernamen lesen.
 *
 * "dmz 170, innenteil + titelseite"            -> dmz, 170
 * "DMZ-Zeitgeschichte 80 innenteil + titelseite" -> DMZ-Zeitgeschichte, 80
 * "schwertertraeger 36 greim, innenteil ..."   -> Schwertertraeger, 36, "Greim"
 * "zuerst 3-2026 innenteil + titelseite"       -> zuerst, 3/2026
 */
export function parseFolderName(folderName: string): ParsedName {
  let rest = folderName.trim();
  // Alles ab dem ersten Hinweis auf den Inhalt abschneiden.
  rest = rest.replace(
    /[\s,+_-]*\b(innenteile?|innen|titelseiten?|titel|umschlag|cover)\b.*$/i,
    "",
  );
  rest = rest.replace(/[\s,;+_-]+$/, "").trim();

  let issueNumber: string | undefined;
  let vor = rest;
  let nach = "";

  const jahr = rest.match(/(\d{1,2})\s*[-/]\s*(\d{4})/);
  const einzeln = rest.match(/\d{1,4}/);
  if (jahr) {
    issueNumber = `${Number(jahr[1])}/${jahr[2]}`;
    vor = rest.slice(0, jahr.index ?? 0);
    nach = rest.slice((jahr.index ?? 0) + jahr[0].length);
  } else if (einzeln) {
    issueNumber = String(Number(einzeln[0]));
    vor = rest.slice(0, einzeln.index ?? 0);
    nach = rest.slice((einzeln.index ?? 0) + einzeln[0].length);
  }

  const publicationName = vor.replace(/[\s,;+_-]+$/, "").trim() || rest || folderName;
  const zusatz = nach.replace(/^[\s,;+_-]+/, "").replace(/[\s,;+_-]+$/, "").trim();

  const issueTitle = zusatz
    ? grossAnfang(zusatz)
    : issueNumber
      ? `${grossAnfang(publicationName)} ${issueNumber}`
      : grossAnfang(publicationName);

  return {
    publicationName: grossAnfang(publicationName),
    publicationSlug: slugify(publicationName),
    issueNumber,
    issueSubtitle: zusatz ? grossAnfang(zusatz) : undefined,
    issueTitle,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}
