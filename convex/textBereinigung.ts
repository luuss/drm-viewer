/**
 * Nachbesserung des Bestands fuer Fehler, die der Import inzwischen selbst
 * vermeidet (extract-service/extractor/textutil.py, idml_extract.py). Dieselben
 * Regeln, aber am fertigen Text: der bedingte Trennstrich ist dort schon zum
 * Strich geworden, das Eurozeichen zum "t".
 *
 * Reine Funktionen, damit Tests und das Werkzeug in devtools.ts dieselben
 * Regeln anwenden.
 */

// "den -Direktor", "„-ZUERST!“": ein Strich nach Leerraum oder einem
// oeffnenden Zeichen, dem ein Grossbuchstabe folgt. Nach "und"/"oder" ist er
// dagegen ein echter Ergaenzungsstrich ("US-Diensten und -Streitkräften"),
// nach einem schliessenden Anfuehrungszeichen Teil des Wortes
// ("„Ampel“-Koalition") — beide bleiben.
const STRICH_VOR_WORT =
  /(?<!(?:^|\s)(?:und|oder|bzw\.|sowie|bis|als|wie))(^|[\s„‚»(/[])-(?=\p{Lu})/gu;
// "Trump--Regierung": Bindestrich plus gewandelter Trennstrich.
const DOPPELSTRICH = /(?<=\p{L})--(?=\p{L})/gu;
// "t 12,80", "t 28,–": das Eurozeichen aus der Symbolschrift.
const EURO_ALS_T = /(^|[\s(,;:])t (?=\d{1,4}(?:[.,]\d{2}|,[–-])(?!\d))/gu;
// Zeichen aus Symbolschriften (Schlusszeichen der DMZ) — leeres Kaestchen.
const SYMBOLZEICHEN = /[-]/gu;

// Wie textutil._AKZENTE: ohne Akut und Gravis ("geht´s" ist ein Apostroph).
const AKZENTE: Record<string, string> = {
  "˘": "̆", // Breve
  "˜": "̃", // Tilde
  "¨": "̈", // Trema
  "ˇ": "̌", // Hatschek
  "˚": "̊", // Ring
  "¸": "̧", // Cedille
  "˛": "̨", // Ogonek
  "˝": "̋", // Doppelakut
  "ˆ": "̂", // Zirkumflex
};

// Wie textutil._VORZUG: passen beide Nachbarn, gewinnt der in der Sprache
// uebliche Buchstabe ("Kog˘alniceanu" ă, "Dog˘ru" ğ, "Don˜a" ñ, "Cˇeské" Č).
const VORZUG: Record<string, string> = {
  "\u02D8": "aAgGuUoOeEiI",
  "\u02DC": "nNaAoOuUiIeE",
  "\u02C7": "cCsSzZrRnNdDtTlLeE",
  "\u00B8": "sStTcCgGkKlLnNrR",
};

/** "Ca˘lin" und "C˘alin" werden "Călin": der Akzent geht an den Nachbarn,
 * mit dem er ein fertiges Zeichen ergibt. */
function akzenteSetzen(text: string): string {
  const zeichen = [...text];
  const out: string[] = [];
  const buchstabe = (z: string | undefined) => !!z && /\p{L}/u.test(z);
  for (let i = 0; i < zeichen.length; i++) {
    const akzent = AKZENTE[zeichen[i]];
    const davor = out[out.length - 1];
    const danach = zeichen[i + 1];
    if (akzent && buchstabe(davor) && buchstabe(danach)) {
      const mitDavor = (davor + akzent).normalize("NFC");
      const mitDanach = (danach + akzent).normalize("NFC");
      let davorGeht = [...mitDavor].length === 1;
      let danachGeht = [...mitDanach].length === 1;
      if (davorGeht && danachGeht) {
        const vorzug = VORZUG[zeichen[i]] ?? "";
        const rang = (b: string) => (vorzug.includes(b) ? vorzug.indexOf(b) : vorzug.length);
        danachGeht = rang(danach) < rang(davor);
        davorGeht = !danachGeht;
      }
      if (davorGeht) {
        out[out.length - 1] = mitDavor;
        continue;
      }
      if (danachGeht) {
        out.push(mitDanach);
        i++;
        continue;
      }
    }
    out.push(zeichen[i]);
  }
  return out.join("");
}

// "Marxisten- Schlangennest", "Bahn- mitarbeiter": umbrochene Titelzeile.
// "Ein- und Ausfuhr" bleibt.
const STRICH_LEER =
  /(\p{L})- (?!(?:und|oder|bis|sowie|als|wie|noch|bzw\.|u\.|&)(?!\p{L}))(\p{L})/gu;

/** Fliesstext, Bildunterschriften: Strich, Euro, Symbolzeichen, Akzente. */
export function textBereinigen(text: string): string {
  const ohneStriche = text
    .replace(STRICH_VOR_WORT, "$1")
    .replace(DOPPELSTRICH, "-")
    .replace(EURO_ALS_T, "$1€ ")
    .replace(SYMBOLZEICHEN, "")
    .replace(/[ \t]{2,}/g, " ");
  return akzenteSetzen(ohneStriche).trim();
}

/** Titel, Untertitel, Verzeichniseintraege: zusaetzlich umbrochene Zeilen. */
export function titelBereinigen(text: string): string {
  return textBereinigen(text).replace(STRICH_LEER, (_g, a: string, b: string) =>
    b === b.toLowerCase() && b !== b.toUpperCase() ? a + b : `${a}-${b}`,
  );
}
