import { describe, expect, it } from "vitest";
import { textBereinigen, titelBereinigen } from "./textBereinigung";

describe("textBereinigen", () => {
  it("nimmt den Strich vor einem Wort weg (bedingter Trennstrich)", () => {
    expect(textBereinigen("warnte er den -Direktor der Behörde")).toBe(
      "warnte er den Direktor der Behörde",
    );
    expect(textBereinigen("Jens -Jeremies aufbaute")).toBe("Jens Jeremies aufbaute");
    expect(textBereinigen("„-ZUERST!“ und zu -PI-News")).toBe("„ZUERST!“ und zu PI-News");
    expect(textBereinigen("-US-Präsident Trump")).toBe("US-Präsident Trump");
    expect(textBereinigen("Trump--Regierung, Berlin--Neukölln")).toBe(
      "Trump-Regierung, Berlin-Neukölln",
    );
  });

  it("laesst echte Striche stehen", () => {
    expect(textBereinigen("Ost- und West-Berlin")).toBe("Ost- und West-Berlin");
    expect(textBereinigen("bei -30 Grad")).toBe("bei -30 Grad");
    expect(textBereinigen("Nordrhein-Westfalen")).toBe("Nordrhein-Westfalen");
    expect(textBereinigen("- erstens")).toBe("- erstens");
    // Ergaenzungsstrich (ZUERST! 3/2025).
    expect(textBereinigen("mit US-Diensten und -Streitkräften")).toBe(
      "mit US-Diensten und -Streitkräften",
    );
  });

  it("macht aus dem t vor dem Preis das Eurozeichen", () => {
    expect(textBereinigen("240 S., Pb., t 28,–")).toBe("240 S., Pb., € 28,–");
    expect(textBereinigen("Art. 460691 t 14,80")).toBe("Art. 460691 € 14,80");
    expect(textBereinigen("früher t 25,95, jetzt nur noch (B) t 12,80")).toBe(
      "früher € 25,95, jetzt nur noch (B) € 12,80",
    );
    // Tonnen und Woerter bleiben.
    expect(textBereinigen("14 t Last, Gewicht 3,5 t")).toBe("14 t Last, Gewicht 3,5 t");
    expect(textBereinigen("geht 12 Stunden")).toBe("geht 12 Stunden");
  });

  it("entfernt Symbolzeichen und setzt Akzente", () => {
    expect(textBereinigen("zahlreiche Flugzeuge. \uf071")).toBe("zahlreiche Flugzeuge.");
    expect(textBereinigen("Ca˘lin Georgescu, Don˜a Isabel")).toBe("Călin Georgescu, Doña Isabel");
    expect(textBereinigen("Kandidaten C˘alin Georgescu")).toBe("Kandidaten Călin Georgescu");
    expect(textBereinigen("Wie geht´s")).toBe("Wie geht´s");
  });
});

describe("titelBereinigen", () => {
  it("verbindet umbrochene Titelzeilen", () => {
    expect(titelBereinigen("„Marxisten- Schlangennest“")).toBe("„Marxisten-Schlangennest“");
    expect(titelBereinigen("Mehr Straftaten gegen Bahn- mitarbeiter")).toBe(
      "Mehr Straftaten gegen Bahnmitarbeiter",
    );
    expect(titelBereinigen("US-Stellvertreter- Weltkrieg in der Ukraine")).toBe(
      "US-Stellvertreter-Weltkrieg in der Ukraine",
    );
    expect(titelBereinigen("Ein- und Ausfuhr")).toBe("Ein- und Ausfuhr");
    expect(titelBereinigen("Klein- Flugzeugträger")).toBe("Klein-Flugzeugträger");
  });
});
