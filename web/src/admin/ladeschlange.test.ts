import { describe, expect, test } from "vitest";
import { Ladeschlange } from "./ladeschlange";

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Ladeschlange", () => {
  test("laesst mehrere Auftraege nebeneinander laufen, aber nicht mehr als erlaubt", async () => {
    const schlange = new Ladeschlange(3);
    let gleichzeitig = 0;
    let hoechststand = 0;
    const auftrag = async () => {
      gleichzeitig += 1;
      hoechststand = Math.max(hoechststand, gleichzeitig);
      await warte(10);
      gleichzeitig -= 1;
    };

    for (let i = 0; i < 9; i++) await schlange.einreihen(auftrag);
    await schlange.fertig();

    expect(hoechststand).toBe(3);
    expect(gleichzeitig).toBe(0);
  });

  test("gibt zurueck, bevor der Auftrag fertig ist", async () => {
    const schlange = new Ladeschlange(2);
    let fertig = false;
    await schlange.einreihen(async () => {
      await warte(30);
      fertig = true;
    });
    // Der Aufrufer darf weiterarbeiten, waehrend der Upload laeuft.
    expect(fertig).toBe(false);
    await schlange.fertig();
    expect(fertig).toBe(true);
  });

  test("reicht den ersten Fehler weiter", async () => {
    const schlange = new Ladeschlange(2);
    await schlange.einreihen(async () => {
      throw new Error("Upload abgelehnt");
    });
    await expect(schlange.fertig()).rejects.toThrow("Upload abgelehnt");
  });

  test("ein Fehler wird nur einmal geworfen", async () => {
    const schlange = new Ladeschlange(1);
    await schlange.einreihen(async () => {
      throw new Error("einmal");
    });
    await expect(schlange.fertig()).rejects.toThrow("einmal");
    await schlange.fertig();
  });
});
