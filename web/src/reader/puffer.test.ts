import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  nochGueltig,
  neuesPaket,
  OFFLINE_FRIST_MS,
  paketFuer,
  pufferAblageSetzen,
  pufferLeeren,
  satzVon,
  seitenFingerabdruck,
  SpeicherAblage,
  vorhandenesPaket,
  type PaketKopf,
} from "./puffer";

const JETZT = 1_800_000_000_000;

function kopf(issueId = "heft-a", userId = "leser-1"): Omit<PaketKopf, "v"> {
  return {
    issueId,
    userId,
    angelegt: JETZT,
    bestaetigt: JETZT,
    zuletzt: JETZT,
    watermark: "leser@example.org",
    seitenStand: "s1",
    fortschritt: null,
    fertig: false,
  };
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function text(daten: ArrayBuffer): string {
  return new TextDecoder().decode(daten);
}

/** Alles, was die Ablage haelt, als Text: darin darf nichts Lesbares stehen. */
function alles(ablage: SpeicherAblage): string {
  return [...ablage.daten.entries()]
    .map(([slot, wert]) => `${slot}=${new TextDecoder("latin1").decode(wert)}`)
    .join("\n");
}

describe("Offline-Puffer", () => {
  let ablage: SpeicherAblage;
  beforeEach(() => {
    ablage = new SpeicherAblage();
    pufferAblageSetzen(ablage);
  });
  afterEach(() => pufferAblageSetzen(null));

  it("legt Kacheln mit dem Schluessel ihrer Sitzung ab und gibt sie unveraendert zurueck", async () => {
    const paket = await neuesPaket(kopf());
    await paket.kachelAblegen(4, "st", 1, 2, 3, 0xdeadbeef, bytes("JPEG-KACHEL"));
    const da = await paket.kachel(4, "st", 1, 2, 3);
    expect(da?.k).toBe(0xdeadbeef);
    expect(da?.verwuerfelt).toBe(true);
    expect(text(da!.daten)).toBe("JPEG-KACHEL");
    expect(await paket.kachel(4, "anderer-stand", 1, 2, 3)).toBeNull();
  });

  it("speichert nichts lesbar: weder Inhalt noch Namen der Eintraege", async () => {
    const paket = await neuesPaket(kopf());
    await paket.kachelAblegen(4, "st", 1, 2, 3, 7, bytes("JPEG-KACHEL"));
    await paket.bildAblegen("bild123", "st", 7, true, bytes("JPEG-BILD"));
    await paket.schriftAblegen("satz", 0, bytes("WOFF2-SCHRIFT"));
    await paket.datenSetzen({ issue: { title: "ZUERST! 3/2026" } } as never);
    const roh = alles(ablage);
    for (const verraeterisch of [
      "JPEG",
      "WOFF2",
      "ZUERST",
      "leser@example.org",
      "heft-a",
      "bild123",
      "t:4",
      "kopf",
    ]) {
      expect(roh).not.toContain(verraeterisch);
    }
  });

  it("oeffnet keinen Eintrag, der an einen anderen Platz kopiert wurde", async () => {
    const paket = await neuesPaket(kopf());
    const neu = async (tun: () => Promise<void>) => {
      const vorher = new Set(ablage.daten.keys());
      await tun();
      return [...ablage.daten.keys()].find((slot) => !vorher.has(slot))!;
    };
    const a = await neu(() => paket.kachelAblegen(1, "st", 0, 0, 0, 7, bytes("A")));
    const b = await neu(() => paket.kachelAblegen(2, "st", 0, 0, 0, 7, bytes("B")));
    ablage.daten.set(b, ablage.daten.get(a)!);
    expect(text((await paket.kachel(1, "st", 0, 0, 0))!.daten)).toBe("A");
    expect(await paket.kachel(2, "st", 0, 0, 0)).toBeNull();
  });

  it("findet das Paket nach dem Neuladen wieder, samt Kopf und Listen", async () => {
    const paket = await neuesPaket(kopf());
    await paket.datenSetzen({ issue: { title: "DMZ 170" } } as never);
    await paket.kopfAendern((k) => {
      k.fortschritt = { mode: "page", pageIndex: 12, articleId: null, updatedAt: JETZT };
    });
    // Neuladen: dieselbe Ablage, frischer Zustand.
    pufferAblageSetzen(ablage);
    const wieder = await paketFuer("heft-a", "leser-1", JETZT + 1000);
    expect(wieder?.kopf.fortschritt?.pageIndex).toBe(12);
    expect(wieder?.daten?.issue.title).toBe("DMZ 170");
  });

  it("haelt nur eine Ausgabe: ein neues Paket raeumt das alte ganz weg", async () => {
    const a = await neuesPaket(kopf("heft-a"));
    await a.kachelAblegen(1, "st", 0, 0, 0, 7, bytes("A"));
    const b = await neuesPaket(kopf("heft-b"));
    expect(a.tot).toBe(true);
    // Spaete Schreibvorgaenge des alten Pakets landen nirgends.
    await a.kachelAblegen(2, "st", 0, 0, 0, 7, bytes("spaet"));
    expect([...ablage.daten.keys()].every((slot) => slot.startsWith(`${b.id}/`))).toBe(true);
    expect(await paketFuer("heft-a", "leser-1", JETZT)).toBeNull();
    expect((await paketFuer("heft-b", "leser-1", JETZT))?.id).toBe(b.id);
  });

  it("gibt das Paket keinem anderen Konto und raeumt es weg", async () => {
    await neuesPaket(kopf("heft-a", "leser-1"));
    expect(await paketFuer("heft-a", "leser-2", JETZT)).toBeNull();
    expect(ablage.daten.size).toBe(0);
  });

  it("zeigt ein abgelaufenes Paket nicht mehr, behaelt es aber zum Auffrischen", async () => {
    const paket = await neuesPaket(kopf());
    const spaeter = JETZT + OFFLINE_FRIST_MS + 1;
    expect(await paketFuer("heft-a", "leser-1", spaeter)).toBeNull();
    expect(await vorhandenesPaket()).toBe(paket);
    await paket.bestaetigen(spaeter);
    expect(await paketFuer("heft-a", "leser-1", spaeter)).toBe(paket);
  });

  it("leert beim Abmelden alles", async () => {
    const paket = await neuesPaket(kopf());
    await paket.kachelAblegen(1, "st", 0, 0, 0, 7, bytes("A"));
    await pufferLeeren();
    expect(ablage.daten.size).toBe(0);
    expect(await ablage.schluessel()).toBeUndefined();
    expect(await vorhandenesPaket()).toBeNull();
    expect(paket.tot).toBe(true);
  });

  it("raeumt Reste eines abgeloesten Pakets beim Oeffnen weg", async () => {
    const paket = await neuesPaket(kopf());
    ablage.daten.set("altes/abc", bytes("rest"));
    pufferAblageSetzen(ablage);
    await vorhandenesPaket();
    await new Promise((ok) => setTimeout(ok, 0));
    expect(ablage.daten.has("altes/abc")).toBe(false);
    expect([...ablage.daten.keys()].some((s) => s.startsWith(`${paket.id}/`))).toBe(true);
  });
});

describe("nochGueltig", () => {
  const k = { ...kopf(), v: 1 as const };

  it("gilt innerhalb der Frist", () => {
    expect(nochGueltig(k, JETZT + OFFLINE_FRIST_MS - 1, "leser-1")).toBe(true);
  });

  it("verfaellt nach der Frist ohne Bestaetigung", () => {
    expect(nochGueltig(k, JETZT + OFFLINE_FRIST_MS + 1, "leser-1")).toBe(false);
  });

  it("verfaellt, wenn jemand die Uhr zurueckstellt", () => {
    const benutzt = { ...k, zuletzt: JETZT + 60 * 60 * 1000 };
    expect(nochGueltig(benutzt, JETZT, "leser-1")).toBe(false);
    expect(nochGueltig(benutzt, JETZT + 55 * 60 * 1000, "leser-1")).toBe(true);
  });

  it("gilt nur fuer das eigene Konto", () => {
    expect(nochGueltig(k, JETZT, "leser-2")).toBe(false);
  });
});

describe("Kennungen", () => {
  it("leitet aus dem Sitzungstoken einen festen Satz ab, ohne das Token zu zeigen", () => {
    const token = "a".repeat(64);
    expect(satzVon(token)).toBe(satzVon(token));
    expect(satzVon(token)).not.toBe(satzVon("b".repeat(64)));
    expect(satzVon(token)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("merkt am Fingerabdruck, wenn eine Seite neu importiert wurde", () => {
    const vorher = seitenFingerabdruck([{ index: 0, stand: "1:100" }, { index: 1, stand: "1:200" }]);
    const nachher = seitenFingerabdruck([{ index: 0, stand: "1:100" }, { index: 1, stand: "2:210" }]);
    expect(vorher).not.toBe(nachher);
  });
});
