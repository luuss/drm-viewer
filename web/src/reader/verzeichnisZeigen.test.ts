import { describe, expect, test } from "vitest";
import { verzeichnisZeigen } from "./verzeichnisZeigen";

describe("verzeichnisZeigen", () => {
  test("Buch-Modus: nur mit gedrucktem Verzeichnis (mehr als der Titel)", () => {
    expect(verzeichnisZeigen(true, 16)).toBe(true);
    expect(verzeichnisZeigen(true, 2)).toBe(true);
    // Erzaehlheft: der eine Eintrag ist der Titel des Textes.
    expect(verzeichnisZeigen(true, 1)).toBe(false);
    expect(verzeichnisZeigen(true, 0)).toBe(false);
    // Laedt noch.
    expect(verzeichnisZeigen(true, undefined)).toBe(false);
  });

  test("Zeitschriften: immer", () => {
    expect(verzeichnisZeigen(false, undefined)).toBe(true);
    expect(verzeichnisZeigen(false, 0)).toBe(true);
    expect(verzeichnisZeigen(false, 1)).toBe(true);
  });
});
