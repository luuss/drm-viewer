/**
 * Werkzeug, kein Test: ARCHIV_LISTE=<liste.json> ARCHIV_AUS=<aus.json> npx vitest run
 * web/src/admin/heftarchiv.liste.test.ts — schreibt die Hefte des Archivs, wie der
 * Import sie findet (tools/weltkrieg/fehlende_hefte.py liest das). Ohne die
 * Variablen wird nichts getan.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { hefteImArchiv } from "./heftarchiv";

const LISTE = process.env.ARCHIV_LISTE;
const AUS = process.env.ARCHIV_AUS;

it.skipIf(!LISTE || !AUS)("Hefte des Archivs ausgeben", { timeout: 120000 }, () => {
  const d = JSON.parse(readFileSync(LISTE!, "utf8"));
  const files = d.dateien.map(([path, size]: [string, number]) => ({
    path,
    name: path.split("/").pop(),
    size,
    file: null as any,
  }));
  const hefte = hefteImArchiv(files).map((h) => ({
    kennung: h.kennung,
    pfad: h.pfad,
    mitIdml: h.mitIdml,
    mitPdf: h.mitPdf,
    // Das Innenteil-PDF, das der Import nimmt; sein Dateidatum steht in der
    // Liste (dritte Spalte) und dient als Erscheinungsdatum (05.11.2026).
    innenteil:
      h.files.find((f) => /\.pdf$/i.test(f.name) && /innenteil/i.test(f.path))?.path ?? null,
  }));
  // Dazu Hefte ohne PDF (nur INDD), die der Import gar nicht anfasst.
  const ohnePdf = new Map<string, string>();
  for (const [path] of d.dateien as [string, number][]) {
    const name = (path.split("/").pop() ?? "").normalize("NFC");
    if (!/innenteil/i.test(name) || !/\.indd$/i.test(name)) continue;
    const m = /^\s*(\d+)\s*([a-zäöü]{0,10})/i.exec(name);
    if (!m) continue;
    const k = (m[1] + m[2]).toLowerCase();
    if (!hefte.some((h) => h.kennung === k)) ohnePdf.set(k, path.split("/").slice(0, -1).join("/"));
  }
  writeFileSync(
    AUS!,
    JSON.stringify({ hefte, nurIndd: [...ohnePdf].map(([kennung, pfad]) => ({ kennung, pfad })) }),
  );
});
