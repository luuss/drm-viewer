import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  SCHUTZ_ALPHABET,
  entschluesseln,
  fnv1a32,
  kachelSchluessel,
  verschluesseler,
  vertauschung,
} from "./schutz";
import { umformungen } from "../web/src/reader/schutzRechnen";

const tileService = fileURLToPath(new URL("../tile-service", import.meta.url));

/** Dieselben Werte in Python (Kachel-Gateway) berechnen. */
function python(code: string): any {
  const out = execFileSync("python3", ["-c", `import json, schutz\n${code}`], {
    cwd: tileService,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

describe("Kopierschutz", () => {
  test("Text kommt verschluesselt und laesst sich zurueckholen", () => {
    const text = "Größte Schlacht – „Kursk“ 1943, Seite 12.";
    const enc = verschluesseler(42, "artikel")(text);
    expect(enc).not.toBe(text);
    expect([...enc].every((c) => c === " " || c.charCodeAt(0) >= 0xe000)).toBe(true);
    expect(entschluesseln(42, enc)).toBe(text);
    // Andere Sitzung, anderer Zeichensalat.
    expect(verschluesseler(43, "artikel")(text)).not.toBe(enc);
  });

  test("Python im Gateway rechnet Bit fuer Bit gleich", () => {
    const py = python(
      `print(json.dumps({"f": schutz.fnv1a32("987:kacheln:x"), "k": schutz.kachel_schluessel(55),` +
        ` "p": schutz.vertauschung(500, 3141592653), "a": schutz.SCHUTZ_ALPHABET,` +
        ` "u": schutz.umformungen(300, 2718281828)}))`,
    );
    expect(py.f).toBe(fnv1a32("987:kacheln:x"));
    expect(py.k).toBe(kachelSchluessel(55));
    expect(py.p).toEqual(vertauschung(500, 3141592653));
    expect(py.a).toBe(SCHUTZ_ALPHABET);
    expect(py.u).toEqual(umformungen(300, 2718281828));
  });
});
