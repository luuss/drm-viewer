import { describe, expect, it } from "vitest";
import { ausVersalien, nameVomUmschlag, schreibungAusSatz } from "./umschlagTitel";
import type { TextItem } from "./textLayer";

const REIHEN = [
  { name: "Weltkrieg Doppelband", match: /doppel/i },
  { name: "Freikorps", match: /freikorps/i },
];

// Titelseite von Weltkrieg 159, wie der Browser sie liest.
const U1_159: TextItem[] = [
  ["Österreich", 0.0088, 0.8064, 0.029, 0.8722, 8.5, 90],
  ["€ 4,95", 0.857, 0.1772, 0.9411, 0.204, 16],
  ["Die 18. Armee unter Generaloberst von Küchler erzwingt im Sommer", 0.032, 0.9243, 0.9227, 0.9444, 12],
  ["erlebnisberichte – Doppelband", 0.07, 0.0121, 0.8496, 0.0611, 29.2],
  ["WELTKRIEG", 0.0491, 0.0089, 0.897, 0.1769, 100],
  ["www.weltkrieg.info", 0.3478, 0.1757, 0.6515, 0.2026, 16],
  ["DER LANGE SCHATTEN", 0.0987, 0.2356, 0.9067, 0.3095, 44],
  ["DER VERGANGENHEIT", 0.1129, 0.3128, 0.8925, 0.3868, 44],
  ["Nr. 159", 0.05, 0.176, 0.1479, 0.2028, 16],
];

describe("nameVomUmschlag", () => {
  it("liest Titel und Reihe von der Titelseite", () => {
    expect(nameVomUmschlag(U1_159, REIHEN)).toEqual({
      titelGedruckt: "DER LANGE SCHATTEN DER VERGANGENHEIT",
      reihe: "Weltkrieg Doppelband",
    });
  });
  it("laesst die Reihe offen, wenn keine gedruckt ist", () => {
    const ohne = U1_159.filter((i) => !i[0].includes("Doppelband"));
    expect(nameVomUmschlag(ohne, REIHEN)?.reihe).toBeNull();
  });
});

describe("schreibungAusSatz", () => {
  it("holt die Schreibung aus dem Satz, auch ueber Zeilenumbrueche", () => {
    const satz = ["Einleitung", "Der lange Schatten\nder Vergangenheit Die 18. Armee …"];
    expect(schreibungAusSatz("DER LANGE SCHATTEN DER VERGANGENHEIT", satz)).toBe(
      "Der lange Schatten der Vergangenheit",
    );
  });
  it("findet nichts, wenn der Satz den Titel nicht kennt", () => {
    expect(schreibungAusSatz("ALLES AUF EINE KARTE", ["anderer Text"])).toBeNull();
  });
  it("macht aus Versalien notfalls einen Satzanfang", () => {
    expect(ausVersalien("ALLES AUF EINE KARTE")).toBe("Alles auf eine Karte");
  });
});

describe("Titelseiten aus dem Archiv", () => {
  const R = [
    { name: "Weltkrieg Doppelband", match: /doppel/i },
    { name: "Freikorps", match: /freikorps/i, umschlag: /freikorps|erlebte geschichte|freiwillige wehrverb/i },
  ];
  it("zaehlt doppelt gesetzte Titelzeilen einmal und erkennt Freikorps am Untertitel", () => {
    const items: TextItem[] = [
      ["Freiwillige Wehrverbände 1918–23", 0.18, 0.21, 0.62, 0.23, 13.2],
      ["Nr. 34", 0.75, 0.21, 0.83, 0.23, 13.2],
      ["Blutiger Januar", 0.05, 0.23, 0.93, 0.35, 70],
      ["Blutiger Januar", 0.05, 0.23, 0.93, 0.35, 70],
      ["ERLEBTE GESCHICHTE", 0.29, 0.03, 0.78, 0.07, 24],
    ];
    expect(nameVomUmschlag(items, R)).toEqual({ titelGedruckt: "Blutiger Januar", reihe: "Freikorps" });
  });
  it("verbindet getrennte Titelzeilen ohne Luecke", () => {
    const items: TextItem[] = [
      ["PAROLE „GROSSER ZAPFEN-", 0.1, 0.3, 0.9, 0.36, 40],
      ["STREICH“", 0.1, 0.37, 0.5, 0.43, 40],
    ];
    expect(nameVomUmschlag(items, R)?.titelGedruckt).toBe("PAROLE „GROSSER ZAPFEN-STREICH“");
  });
  it("holt die Schreibung von der Titelseite des Innenteils", () => {
    expect(
      schreibungAusSatz("DAS LETZTE BATAILLON ENTSCHEIDET", ["Das letzte Bataillon entscheidet!\nVorstoß an die Wolga"]),
    ).toBe("Das letzte Bataillon entscheidet");
    expect(ausVersalien("„WINDHUNDE“ IN SCHWERER SEE")).toBe("„Windhunde“ in Schwerer See");
  });
});
