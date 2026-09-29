import { describe, expect, test } from "vitest";
import { geraetName, safeNext } from "./anmeldung";

describe("Anmeldung im Browser", () => {
  test("Zielpfad", () => {
    expect(safeNext("/warenkorb")).toBe("/warenkorb");
    expect(safeNext("//evil.example/x")).toBe("/library");
    expect(safeNext(null)).toBe("/library");
  });

  test("Geraetename", () => {
    expect(
      geraetName(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome auf Android");
    expect(
      geraetName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari auf iPhone");
    expect(
      geraetName("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"),
    ).toBe("Firefox auf Windows");
  });
});
