/**
 * Nachbesserung des Bestands fuer Fehler, die der Import inzwischen selbst
 * vermeidet (extract-service/extractor/textutil.py, idml_extract.py). Dieselben
 * Regeln, aber am fertigen Text: der bedingte Trennstrich ist dort schon zum
 * Strich geworden, das Eurozeichen zum "t".
 *
 * Reine Funktionen, damit Tests und das Werkzeug in devtools.ts dieselben
 * Regeln anwenden.
 */

// "den -Direktor", "„-ZUERST!“": ein Strich ohne Wort davor, dem ein
// Grossbuchstabe folgt. Nach "und"/"oder" ist er dagegen ein echter
// Ergaenzungsstrich ("US-Diensten und -Streitkräften") und bleibt.
const STRICH_VOR_WORT =
  /(?<!(?:^|\s)(?:und|oder|bzw\.|sowie|bis|als|wie))(^|[\s„“"«»‚‘(/[])-(?=\p{Lu})/gu;
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

/** "Ca˘lin" und "C˘alin" werden "Călin": der Akzent geht an den Nachbarn,
 * mit dem er ein fertiges Zeichen ergibt. */
function akzenteSetzen(text: string): string {
  const zeichen = [...text];
  const out: string[] = [];
  const buchstabe = (z: string | undefined) => !!z && /\p{L}/u.test(z);
  for (let i = 0; i < zeichen.length; i++) {
    const akzent = AKZENTE[zeichen[i]];
    if (akzent && buchstabe(out[out.length - 1]) && buchstabe(zeichen[i + 1])) {
      const mitDavor = (out[out.length - 1] + akzent).normalize("NFC");
      if ([...mitDavor].length === 1) {
        out[out.length - 1] = mitDavor;
        continue;
      }
      const mitDanach = (zeichen[i + 1] + akzent).normalize("NFC");
      if ([...mitDanach].length === 1) {
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
