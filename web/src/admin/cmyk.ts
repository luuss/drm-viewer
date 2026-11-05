/**
 * CMYK nach sRGB mit Farbprofil (LittleCMS als WASM).
 *
 * Die Druckvorstufe liefert die Bilder in `Links/` als CMYK-TIFF. Die
 * einfache Formel `R = (1-C)(1-K)` (UTIF ohne Farbmanagement) kennt weder
 * Papier noch Druckfarben: Rot und Haut werden zu bunt, Tiefen zu dunkel.
 * So stand das Titelbild von ZUERST! 11/2026 mit falschen Farben im Leser
 * und auf zuerst.de.
 *
 * Richtig ist die Umrechnung ueber das Profil, fuer das die Datei separiert
 * ist: das eingebettete (TIFF-Tag 34675), sonst FOGRA39 (ISO Coated v2,
 * Standard fuer Offset auf gestrichenem Papier in Deutschland). Absicht
 * relativ farbmetrisch mit Tiefenkompensierung, wie InDesign mit den
 * Farbeinstellungen "Europa Druckvorstufe".
 *
 * Profil: colord-data `FOGRA39L_coated.icc`, CC0-1.0.
 */

import {
  instantiate,
  INTENT_RELATIVE_COLORIMETRIC,
  TYPE_CMYK_8,
  TYPE_RGB_8,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
} from "lcms-wasm";
import wasmUrl from "lcms-wasm/dist/lcms.wasm?url";
import fogra39Url from "./icc/FOGRA39L_coated.icc?url";

type Lcms = Awaited<ReturnType<typeof instantiate>>;

let lcmsPromise: Promise<Lcms> | null = null;
let standardProfil: Promise<Uint8Array> | null = null;

function lcms(): Promise<Lcms> {
  // Ein Fehlschlag (Netz kurz weg) darf nicht fuer die ganze Sitzung haengen bleiben.
  lcmsPromise ??= instantiate({ locateFile: () => wasmUrl }).catch((e) => {
    lcmsPromise = null;
    throw e;
  });
  return lcmsPromise;
}

function fogra39(): Promise<Uint8Array> {
  standardProfil ??= fetch(fogra39Url)
    .then((r) => {
      if (!r.ok) throw new Error(`Farbprofil FOGRA39: ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b))
    .catch((e) => {
      standardProfil = null;
      throw e;
    });
  return standardProfil;
}

/** Zeilen je Schritt: begrenzt den Speicher im WASM-Heap bei Druckaufloesung. */
const ZEILEN = 256;

/**
 * CMYK-Bildpunkte (8 Bit, 0 = kein Farbauftrag) in RGBA umrechnen.
 * `kanaele` 4 oder 5; ein fuenfter Kanal ist Alpha und wird auf Weiss gelegt.
 * `icc` ist das eingebettete Profil, falls vorhanden und CMYK.
 */
export async function cmykZuRgba(
  daten: Uint8Array,
  width: number,
  height: number,
  kanaele: number,
  icc?: Uint8Array | null,
): Promise<Uint8ClampedArray> {
  const cms = await lcms();
  const ausgang = cms.cmsCreate_sRGBProfile();
  // Erst das eingebettete Profil, dann FOGRA39: ein Profil kann sich oeffnen
  // lassen und trotzdem keine Umrechnung hergeben.
  const anlegen = (profil: Uint8Array): number => {
    const eingang = cms.cmsOpenProfileFromMem(profil, profil.byteLength);
    if (!eingang) return 0;
    try {
      if (cms.cmsGetColorSpaceASCII(eingang) !== "CMYK") return 0;
      return cms.cmsCreateTransform(
        eingang,
        TYPE_CMYK_8,
        ausgang,
        TYPE_RGB_8,
        INTENT_RELATIVE_COLORIMETRIC,
        cmsFLAGS_BLACKPOINTCOMPENSATION,
      );
    } finally {
      cms.cmsCloseProfile(eingang);
    }
  };
  let transform = icc && icc.length > 128 ? anlegen(icc) : 0;
  if (!transform) transform = anlegen(await fogra39());
  cms.cmsCloseProfile(ausgang);
  if (!transform) throw new Error("CMYK-Umrechnung liess sich nicht anlegen");

  const rgba = new Uint8ClampedArray(width * height * 4);
  try {
    for (let y0 = 0; y0 < height; y0 += ZEILEN) {
      const zeilen = Math.min(ZEILEN, height - y0);
      const n = zeilen * width;
      const cmyk = new Uint8Array(n * 4);
      const start = y0 * width * kanaele;
      for (let i = 0; i < n; i++) {
        const s = start + i * kanaele;
        cmyk[i * 4] = daten[s];
        cmyk[i * 4 + 1] = daten[s + 1];
        cmyk[i * 4 + 2] = daten[s + 2];
        cmyk[i * 4 + 3] = daten[s + 3];
      }
      const rgb = cms.cmsDoTransform(transform, cmyk, n) as Uint8Array;
      const ziel = y0 * width * 4;
      for (let i = 0; i < n; i++) {
        let r = rgb[i * 3];
        let g = rgb[i * 3 + 1];
        let b = rgb[i * 3 + 2];
        if (kanaele > 4) {
          const a = daten[start + i * kanaele + 4] / 255;
          r = r * a + 255 * (1 - a);
          g = g * a + 255 * (1 - a);
          b = b * a + 255 * (1 - a);
        }
        rgba[ziel + i * 4] = r;
        rgba[ziel + i * 4 + 1] = g;
        rgba[ziel + i * 4 + 2] = b;
        rgba[ziel + i * 4 + 3] = 255;
      }
    }
  } finally {
    cms.cmsDeleteTransform(transform);
  }
  return rgba;
}
