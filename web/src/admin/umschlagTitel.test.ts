import { describe, expect, it } from "vitest";
import { ausVersalien, nameVomUmschlag, schreibungAusSatz, schreibungJeWort, woerterImSatz } from "./umschlagTitel";
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

// Titelseiten von digital.weltkrieg-online.de (Textebene, 05.11.2026).
const U1_327: TextItem[] = [
  ["erlebnisberichte – originalband", 0.0919, 0.0134, 0.8944, 0.0624, 29.2],
  ["WELTKRIEG", 0.0693, 0.0111, 0.9172, 0.1791, 100],
  ["www.weltkrieg.info", 0.609, 0.1783, 0.9128, 0.2052, 16],
  ["Nr. 327", 0.0735, 0.1775, 0.1737, 0.2043, 16],
  ["„GENERAL-", 0.047, 0.2181, 0.5044, 0.3021, 50],
  ["STÄBLER“", 0.0697, 0.3021, 0.4817, 0.3861, 50],
  ["SANDER", 0.1074, 0.3861, 0.444, 0.4701, 50],
];
const U1_121: TextItem[] = [
  ["www.weltkrieg.info", 0.0897, 0.2183, 0.3894, 0.2452, 16],
  ["nr. 121", 0.0897, 0.1784, 0.1816, 0.2053, 16],
  ["€ 4,45", 0.8593, 0.1778, 0.9419, 0.2047, 16],
  ["DURCHBRUCH", 0.3681, 0.2602, 0.9302, 0.3442, 50],
  ["ZUR KRIM", 0.5262, 0.3409, 0.9302, 0.4248, 50],
  ["erlebnisberichte – Doppelband", 0.0824, 0.0119, 0.8431, 0.0608, 29.2],
  ["WELTKRIEG", 0.0666, 0.0112, 0.8936, 0.1792, 100],
];
// Fruehes Magazin: Bildunterschrift oben, Schriftzug darunter, kein Titel.
const U1_MAGAZIN_2: TextItem[] = [
  ["MAGAZIN", 0.6011, 0.0773, 1, 0.2318, 105.1, 90],
  ["WELTKRIEG", 0.5855, 0.2039, 0.728, 0.2473, 29.5],
  ["WELTKRIEG", 0.5846, 0.2047, 0.7271, 0.2481, 29.5],
  ["Geschützbedienung", 0.4197, 0.0708, 0.9039, 0.1031, 22],
  ["vom Kgl. Preuß. 1. Pommerschen Feldartillerie-Regiment Nr. 2", 0.383, 0.0829, 1, 0.1035, 14],
];
// "2o26": ein 0,5 % breiter Rest am Bund, groesste Schrift der Seite.
const U1_LEGION_43: TextItem[] = [
  ["Die Fremdenlegion im", 0.6044, 0.5138, 0.9394, 0.5474, 20],
  ["Kampf gegen „Cobra“-", 0.5912, 0.5491, 0.9394, 0.5827, 20],
  ["2o26", 0, 0, 0.005, 0.285, 215],
  ["Hexenkessel", 0.3454, 0.2594, 0.907, 0.3313, 42.8],
  ["Maya-Maya", 0.3656, 0.3241, 0.8867, 0.396, 42.8],
];
const U1_FREIKORPS_31: TextItem[] = [
  ["Freiwillige Wehrverbände 1918–23", 0.1835, 0.2117, 0.6213, 0.2339, 13.2],
  ["Nr. 31", 0.756, 0.2117, 0.8293, 0.2339, 13.2],
  ["Krieg", 0.0997, 0.2112, 0.3727, 0.3254, 68],
  ["nach dem Krieg", 0.2469, 0.3121, 0.9091, 0.4045, 55],
  ["ERLEBTE GESCHICHTE", 0.2862, 0.027, 0.778, 0.0673, 24],
];
// Zierschrift: die Woerter in Stuecken, Versalien teils als Kleinbuchstaben.
const U1_137: TextItem[] = [
  ["www.weltkrieg.info", 0.0897, 0.2116, 0.3894, 0.2385, 16],
  ["nr. 137", 0.0897, 0.1784, 0.184, 0.2053, 16],
  ["b", 0.4178, 0.2326, 0.4651, 0.3082, 45],
  ["ombenk", 0.4688, 0.2326, 0.7807, 0.3082, 45],
  ["R", 0.7828, 0.2326, 0.8308, 0.3082, 45],
  ["ieg", 0.8329, 0.2326, 0.9532, 0.3082, 45],
  ["in de", 0.7044, 0.3098, 0.9031, 0.3854, 45],
  ["R", 0.9052, 0.3098, 0.9532, 0.3854, 45],
  ["b", 0.6615, 0.3871, 0.7088, 0.4627, 45],
  ["ocage", 0.7125, 0.3871, 0.9532, 0.4627, 45],
  ["Weltkrieg", 0.0666, 0.0112, 0.8936, 0.1792, 100],
];

describe("Kopf der Titelseite (05.11.2026)", () => {
  const titel = (items: TextItem[]) => nameVomUmschlag(items, REIHEN)?.titelGedruckt ?? "";

  it("nimmt eine Titelzeile, die knapp unter dem Kopf beginnt (bis 05.11. weggefallen)", () => {
    // „GENERAL- begann bei 21,8 % und galt als Kopf: Titel war „Stäbler“ Sander".
    expect(titel(U1_327)).toBe("„GENERAL-STÄBLER“ SANDER");
  });
  it("zaehlt Nummer, Preis und Adresse unter dem Schriftzug zum Kopf, nicht zum Titel", () => {
    expect(titel(U1_121)).toBe("DURCHBRUCH ZUR KRIM");
    expect(titel(U1_159)).toBe("DER LANGE SCHATTEN DER VERGANGENHEIT");
  });
  it("nimmt ueber dem Schriftzug keine Bildunterschrift als Titel", () => {
    expect(titel(U1_MAGAZIN_2)).toBe("");
  });
  it("uebergeht schmale Reste am Bund, auch in grosser Schrift", () => {
    expect(titel(U1_LEGION_43)).toBe("Hexenkessel Maya-Maya");
  });
  it("nimmt eine Titelzeile in etwas kleinerer Schrift direkt darunter dazu", () => {
    expect(titel(U1_FREIKORPS_31)).toBe("Krieg nach dem Krieg");
  });
  it("laesst eine Unterzeile in kleiner Schrift weg", () => {
    // Die Unterzeile von Legion 43 (20 Punkt) steht weit unter dem Titel.
    expect(titel(U1_LEGION_43)).not.toMatch(/Fremdenlegion/);
  });
  it("liest die Reihe aus der Zeile ganz oben, nicht aus dem Titel", () => {
    // Grossband 147: "DOPPELSCHUSS" passte bis 05.11. auf Doppelband.
    const R = [
      { name: "Weltkrieg Doppelband", match: /doppel/i },
      { name: "Weltkrieg Großband", match: /gro(ss|ß)band/i },
      { name: "Weltkrieg Soldaten", match: /soldaten/i },
      { name: "Freikorps", match: /freikorps/i, umschlag: /freikorps|erlebte geschichte|freiwillige wehrverb/i },
    ];
    const U1_147: TextItem[] = [
      ["erlebnisberichte – Grossband", 0.09, 0.0111, 0.83, 0.0601, 29.2],
      ["WELTKRIEG", 0.0419, 0.0112, 0.8745, 0.1792, 100],
      ["nr. 147", 0.0719, 0.1784, 0.1671, 0.2053, 16],
      ["DOPPELSCHUSS", 0.2585, 0.2371, 0.9135, 0.3211, 50],
      ["R0T", 0.5078, 0.3194, 0.6642, 0.4034, 50],
    ];
    expect(nameVomUmschlag(U1_147, R)?.reihe).toBe("Weltkrieg Großband");
    // Freikorps 25: "Sturmsoldaten" in der Unterzeile ist nicht die Reihe.
    const U1_FK25: TextItem[] = [
      ["ERLEBTE GESCHICHTE", 0.2862, 0.027, 0.778, 0.0673, 24],
      ["Nr. 25", 0.756, 0.2093, 0.8293, 0.2315, 13.2],
      ["Sturmsoldaten", 0.0465, 0.2872, 0.3243, 0.3158, 17],
      ["„Sieg", 0.049, 0.4171, 0.3085, 0.523, 63],
    ];
    expect(nameVomUmschlag(U1_FK25, R)?.reihe).toBe("Freikorps");
    // Ein Doppelband bleibt Doppelband.
    expect(nameVomUmschlag(U1_121, R)?.reihe).toBe("Weltkrieg Doppelband");
  });
  it("setzt Stuecke eines Worts ohne Luecke zusammen, getrennte Woerter nicht", () => {
    expect(titel(U1_137)).toBe("bombenkRieg in deR bocage");
    expect(titel(U1_121)).toContain("ZUR KRIM");
  });
});

describe("Schreibung aus dem Satz (05.11.2026)", () => {
  it("nimmt Versal-SS als ß", () => {
    expect(
      schreibungAusSatz("„MARDER“ ZWISCHEN THEISS UND MÁTRA", ["„Marder“ zwischen Theiß und Mátra\nUngarn 1944"]),
    ).toBe("„Marder“ zwischen Theiß und Mátra");
  });
  it("loest eine Trennung des Umschlags nach dem Satz auf, ein echter Bindestrich bleibt", () => {
    expect(schreibungAusSatz("OBERST-LEUTNANT RICHARD GRÜNERT", ["Oberstleutnant Richard Grünert"])).toBe(
      "Oberstleutnant Richard Grünert",
    );
    expect(
      schreibungAusSatz("ANGRIFF AUF DIE RUPEL-STELLUNG", ["Angriff auf die Rupel-Stellung"]),
    ).toBe("Angriff auf die Rupel-Stellung");
  });
  it("nimmt den Bindestrich des Satzes, wo der Umschlag umbricht", () => {
    expect(schreibungAusSatz("HERMANN HEINRICH BEHREND", ["Generalmajor Hermann-Heinrich Behrend"])).toBe(
      "Hermann-Heinrich Behrend",
    );
  });
  it("behaelt die Satzzeichen des Umschlags", () => {
    expect(
      schreibungAusSatz("„DAS ALLES WEGEN ZWEIER BRÜCKEN!“", ["„Das alles wegen zweier Brücken…“\nEine Kampfschwimmergruppe"]),
    ).toBe("„Das alles wegen zweier Brücken!“");
  });
  it("beginnt gross, auch wenn der Satz den Titel nur im Fliesstext hat", () => {
    expect(schreibungAusSatz("VERGESSENE FRONT", ["die Kämpfe an der vergessene Front"])).toBe("Vergessene Front");
    // Ein Titel im Satz (gross am Anfang) geht einem frueheren Fund im
    // Fliesstext vor.
    expect(schreibungAusSatz("KAMPF UM BASTOGNE", ["der kampf Um Bastogne begann", "Kampf um Bastogne"])).toBe(
      "Kampf um Bastogne",
    );
  });
  it("liest eine Null im Wort als O, Zahlen bleiben Zahlen", () => {
    expect(schreibungAusSatz("DOPPELSCHUSS R0T", ["Doppelschuß Rot\nFrankreich 1940"])).toBe("Doppelschuß Rot");
    expect(schreibungAusSatz("ORKANBÖEN ÜBER U 47", ["Orkanböen über U 47"])).toBe("Orkanböen über U 47");
    expect(schreibungAusSatz("RAUM 100", ["Raum 1oo"])).toBeNull();
  });
  it("laesst eine Zahl am Anfang stehen", () => {
    expect(schreibungAusSatz("14 MANN UND EIN BEFEHL", ["14 Mann und ein Befehl"])).toBe("14 Mann und ein Befehl");
  });
  it("macht aus Zierschrift-Versalien einen lesbaren Titel, normale Titel bleiben", () => {
    expect(ausVersalien("bombenkRieg in deR bocage")).toBe("Bombenkrieg in der Bocage");
    expect(ausVersalien("Ein Himmel voller „Spitfire“")).toBe("Ein Himmel voller „Spitfire“");
  });
});

describe("Woerter im Satz (05.11.2026)", () => {
  const satz = ["Der Sanitäter des Bataillons war Oberfeldwebel Franz Schmitz.", "Theiß und Mátra"];
  it("bestaetigt einen Titel, dessen Woerter alle im Heft stehen", () => {
    expect(woerterImSatz("Sanitäter Franz Schmitz", satz)).toBe(true);
    expect(woerterImSatz("„Marder“ zwischen THEISS und MÁTRA", ["„Marder“ zwischen Theiß und Mátra"])).toBe(true);
  });
  it("bestaetigt keine Zierschrift-Reste", () => {
    expect(woerterImSatz("b ombenk R ieg", ["Bombenkrieg in der Bocage"])).toBe(false);
  });
  it("schreibt Wort fuer Wort wie der Satz, das erste Wort gross", () => {
    expect(schreibungJeWort("ZUM WESTWALL ZURÜCK", ["Zurück zum Westwall", "und dann ging es zurück zum Westwall"])).toBe(
      "Zum Westwall zurück",
    );
    expect(schreibungJeWort("GANZ UNBEKANNT", ["anderer Text"])).toBeNull();
    // Ein Name bleibt gross, auch wenn das Wort einmal als Adjektiv klein steht.
    expect(
      schreibungJeWort("PANZER-AS ERNST BOLBRINKER", [
        "Generalmajor Ernst Bolbrinker war ein Panzer-As. Die Lage war ernst. Als Ernst Bolbrinker kam",
      ]),
    ).toBe("Panzer-As Ernst Bolbrinker");
  });
});
