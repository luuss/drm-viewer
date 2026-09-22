import { describe, expect, it } from "vitest";
import {
  classifyFolder,
  fortschrittProzent,
  IMPORT_PHASEN,
  parseFolderName,
  slugify,
  type ImportPhase,
  type ScannedFile,
} from "./folderScan";

function f(path: string, size = 1000): ScannedFile {
  const name = path.split("/").pop() ?? path;
  return { path, name, size, file: { name, size } as unknown as File };
}

/** Der Zuschnitt, in dem die Druckvorstufe liefert. */
function musterordner(): ScannedFile[] {
  return [
    f(".DS_Store", 6148),
    f("DMZ 170 innen.pdf", 140_373_233),
    f("dmz 170 titel.jpg", 209_406),
    f("dmz 170 titel.tif", 5_022_652),
    f("DMZ 170.idml", 1_831_347),
    f("DMZ 170.indd", 81_674_240),
    f("Document fonts/Arial.ttf", 800_000),
    f("Document fonts/AdobeFnt14.lst", 1000),
    f("Links/03 - Robert Greim 1905.tif", 12_000_000),
    f("Links/06 - Greim 1934.tif", 9_000_000),
    f("Links/19 Karte RK Greim 8pt.ai", 3_000_000),
  ];
}

describe("classifyFolder", () => {
  it("verteilt die Rollen des Musterordners", () => {
    const plan = classifyFolder("dmz 170, innenteil + titelseite", musterordner());
    expect(plan.inner?.name).toBe("DMZ 170 innen.pdf");
    expect(plan.idml?.name).toBe("DMZ 170.idml");
    expect(plan.coverImage?.name).toBe("dmz 170 titel.tif");
    expect(plan.indd.map((x) => x.name)).toEqual(["DMZ 170.indd"]);
    expect(plan.artwork.map((x) => x.name)).toEqual([
      "03 - Robert Greim 1905.tif",
      "06 - Greim 1934.tif",
    ]);
    expect(plan.cover).toBeUndefined();
    expect(plan.problems).toEqual([]);
  });

  it("laedt nur PDF und Satzdatei unveraendert hoch", () => {
    const plan = classifyFolder("dmz 170", musterordner());
    expect(plan.uploadBytes).toBe(140_373_233 + 1_831_347);
    // Der Ordner selbst ist ein Vielfaches davon.
    expect(plan.totalBytes).toBeGreaterThan(plan.uploadBytes * 1.5);
  });

  it("uebergeht Schriften, Systemdateien und nicht lesbare Bildformate", () => {
    const plan = classifyFolder("x", musterordner());
    const gruende = plan.ignored.map((e) => `${e.file.name}: ${e.reason}`);
    expect(gruende).toContain("Arial.ttf: Schrift");
    expect(gruende).toContain(".DS_Store: Systemdatei");
    expect(gruende).toContain("dmz 170 titel.jpg: Zweite Fassung der Titelseite");
    expect(gruende).toContain(
      "19 Karte RK Greim 8pt.ai: Kein lesbares Bildformat",
    );
  });

  it("trennt Innenteil und Umschlag, wenn beide als PDF kommen", () => {
    const plan = classifyFolder("zuerst 3-2026", [
      f("zuerst 3-2026 innenteil.pdf", 90_000_000),
      f("zuerst 3-2026 umschlag.pdf", 10_000_000),
      f("zuerst 3-2026.idml", 1_000_000),
    ]);
    expect(plan.inner?.name).toBe("zuerst 3-2026 innenteil.pdf");
    expect(plan.cover?.name).toBe("zuerst 3-2026 umschlag.pdf");
  });

  it("nimmt das einzige PDF als Innenteil, auch wenn es Titel heisst", () => {
    const plan = classifyFolder("x", [f("titelheft.pdf", 5)]);
    expect(plan.inner?.name).toBe("titelheft.pdf");
    expect(plan.cover).toBeUndefined();
  });

  it("meldet einen Ordner ohne Innenteil als Problem", () => {
    const plan = classifyFolder("x", [f("Links/bild.tif", 10)]);
    expect(plan.problems[0]).toMatch(/Kein Innenteil/);
  });
});

describe("parseFolderName", () => {
  const faelle: [string, string, string | undefined, string][] = [
    ["dmz 170, innenteil + titelseite", "dmz", "170", "Dmz 170"],
    [
      "DMZ-Zeitgeschichte 80 innenteil + titelseite",
      "dmz-zeitgeschichte",
      "80",
      "DMZ-Zeitgeschichte 80",
    ],
    [
      "schwerterträger 36 greim, innenteil + titelseite",
      "schwertertraeger",
      "36",
      "Greim",
    ],
    ["zuerst 3-2026 innenteil + titelseite", "zuerst", "3/2026", "Zuerst 3/2026"],
  ];
  for (const [ordner, slug, nummer, titel] of faelle) {
    it(`liest "${ordner}"`, () => {
      const p = parseFolderName(ordner);
      expect(p.publicationSlug).toBe(slug);
      expect(p.issueNumber).toBe(nummer);
      expect(p.issueTitle).toBe(titel);
    });
  }

  it("kommt ohne Heftnummer aus", () => {
    const p = parseFolderName("sonderheft, innenteil");
    expect(p.publicationName).toBe("Sonderheft");
    expect(p.issueNumber).toBeUndefined();
  });
});

describe("slugify", () => {
  it("wandelt Umlaute in Buchstabenpaare", () => {
    expect(slugify("Schwerterträger Groß")).toBe("schwertertraeger-gross");
  });
});

describe("fortschrittProzent", () => {
  it("teilt hundert Prozent auf die Abschnitte auf", () => {
    const summe = IMPORT_PHASEN.reduce((n, p) => n + p.gewicht, 0);
    expect(summe).toBe(100);
  });

  it("faengt bei null an und endet bei hundert", () => {
    expect(fortschrittProzent([])).toBe(0);
    expect(fortschrittProzent(IMPORT_PHASEN.map((p) => p.id))).toBe(100);
  });

  it("rechnet den laufenden Abschnitt anteilig dazu", () => {
    // Heft (2) erledigt, Innenteil (25) zur Haelfte.
    expect(fortschrittProzent(["heft"], "innenteil", 0.5)).toBe(15);
    // Bild 25 von 50 in der Bilderphase (50), davor 2+25+5+5+5 = 42.
    expect(
      fortschrittProzent(
        ["heft", "innenteil", "umschlag", "satzdatei", "titelseite"],
        "bilder",
        25 / 50,
      ),
    ).toBe(67);
  });

  it("zaehlt uebersprungene Abschnitte als erledigt", () => {
    // Ein Ordner ohne Umschlag, Satzdatei und Bilder kommt trotzdem an.
    const ohne: ImportPhase[] = [
      "heft",
      "innenteil",
      "umschlag",
      "satzdatei",
      "titelseite",
      "bilder",
      "reihenfolge",
      "aufbereitung",
    ];
    expect(fortschrittProzent(ohne)).toBe(100);
  });

  it("bleibt bei doppelten Eintraegen und krummen Anteilen im Rahmen", () => {
    expect(fortschrittProzent(["heft", "heft"], "heft", 1)).toBe(2);
    expect(fortschrittProzent([], "bilder", 5)).toBe(50);
    expect(fortschrittProzent([], "bilder", -1)).toBe(0);
  });
});
