import { describe, expect, it } from "vitest";
import { artikelAufSeite } from "./artikelAufSeite";

const artikel = [
  { id: "editorial", pageStart: 2, pageEnd: 2 },
  { id: "leserbriefe", pageStart: 80, pageEnd: 81 },
  { id: "kurzmeldung", pageStart: 81, pageEnd: 81 },
];

describe("artikelAufSeite", () => {
  it("findet den Artikel, der die Seite abdeckt, bei mehreren den ersten", () => {
    expect(artikelAufSeite(artikel, 80)?.id).toBe("leserbriefe");
    expect(artikelAufSeite(artikel, 81)?.id).toBe("leserbriefe");
    expect(artikelAufSeite(artikel, 2)?.id).toBe("editorial");
  });

  it("ohne Artikel auf der Seite: keiner", () => {
    expect(artikelAufSeite(artikel, 82)).toBeNull();
    expect(artikelAufSeite([], 3)).toBeNull();
  });
});
