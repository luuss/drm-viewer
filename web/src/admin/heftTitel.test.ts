import { describe, expect, it } from "vitest";
import {
  istSammelheft,
  kolumnentitel,
  kopfzeile,
  titelEntscheiden,
  titelSchluessel,
  type Kolumnentitel,
} from "./heftTitel";
import type { TextItem, TextPage } from "./textLayer";

// Kopf einer Innenseite wie in der Textebene der Anlage (Doppelband 150):
// Seitenzahl und Kolumnentitel als eigene Stuecke auf einer Hoehe, darunter
// der Satz.
function seite(i: number, kopf: string | null, rumpf = "Gleichgewicht. Der Fahrer hielt an."): TextPage {
  const items: TextItem[] = [];
  const zahl = String(i + 3);
  if (i % 2 === 1) {
    items.push([zahl, 0.054, 0.054, 0.08, 0.074, 12]);
    if (kopf) items.push([kopf, 0.4, 0.055, 0.9, 0.075, 12]);
  } else {
    items.push([zahl, 0.054, 0.054, 0.08, 0.074, 12]);
    items.push(["WELTKRIEG", 0.4, 0.054, 0.6, 0.076, 13]);
  }
  items.push([rumpf, 0.1, 0.101, 0.9, 0.122, 12.5]);
  return { sourcePageIndex: i, items };
}

function heft(kopf: string, seiten = 60): TextPage[] {
  return Array.from({ length: seiten }, (_, i) => seite(i, kopf));
}

describe("Kopfzeile einer Seite", () => {
  it("nimmt den Kolumnentitel ohne Seitenzahl", () => {
    expect(kopfzeile(seite(1, "Hier endet die Fahrt…").items)).toBe("Hier endet die Fahrt…");
  });
  it("laesst eine Zahl im Titel stehen", () => {
    expect(kopfzeile(seite(1, "Orkanböen über U 47").items)).toBe("Orkanböen über U 47");
  });
  it("hat auf geraden Seiten mit dem Schriftzug keinen Kolumnentitel", () => {
    expect(kopfzeile(seite(0, null).items)).toBeNull();
    // Soldaten setzen den Schriftzug klein.
    const klein: TextItem[] = [["10", 0.05, 0.05, 0.08, 0.07, 12], ["weltkrieg", 0.4, 0.05, 0.6, 0.07, 13]];
    expect(kopfzeile(klein)).toBeNull();
  });
  it("haelt einen Druckvermerk nicht fuer einen Titel", () => {
    expect(kopfzeile([["7mag Innenteil.indd 42 28.10.15 18:49", 0.1, 0.02, 0.9, 0.03, 8]])).toBeNull();
  });
});

describe("Kolumnentitel eines Hefts", () => {
  it("findet den wiederkehrenden Kopf, Splitter zaehlen nicht", () => {
    const seiten = heft("„Das alles wegen zweier Brücken…!“");
    seiten[5] = seite(5, "Kompakt");
    seiten[7] = seite(7, "Kompakt");
    const k = kolumnentitel(seiten)!;
    expect(k.text).toBe("„Das alles wegen zweier Brücken…!“");
    expect(k.anzahl).toBe(28);
    expect(istSammelheft(k)).toBe(false);
  });
  it("erkennt ein Sammelheft an mehreren Artikelkoepfen (Magazin)", () => {
    const artikel = ["Narvik erobert und wieder verloren", "Major Wolfgang Wahl", "Halten, nichts als halten!", "Das ist noch nicht das Ende!"];
    const seiten = Array.from({ length: 64 }, (_, i) => seite(i, artikel[Math.floor(i / 16)]));
    const k = kolumnentitel(seiten)!;
    expect(istSammelheft(k)).toBe(true);
  });
  it("hat ohne wiederkehrenden Kopf keinen Kolumnentitel", () => {
    const seiten = [seite(1, "Einmal"), seite(3, "Zweimal"), seite(5, "Dreimal")];
    expect(kolumnentitel(seiten)).toBeNull();
  });
});

const K = (text: string, anzahl = 30, koepfe?: { text: string; anzahl: number }[]): Kolumnentitel => ({
  text,
  anzahl,
  koepfe: koepfe ?? [{ text, anzahl }],
});
const MAGAZIN = K("Generalleutnant Adolf Galland", 22, [
  { text: "Generalleutnant Adolf Galland", anzahl: 22 },
  { text: "Mit dem Rücken zur Wand", anzahl: 9 },
  { text: "Rammjäger", anzahl: 8 },
  { text: "An vorderster Front", anzahl: 8 },
]);

describe("Titel waehlen", () => {
  it("nimmt den Titel, wenn Titelseite und Kolumnentitel einig sind", () => {
    const e = titelEntscheiden({
      umschlag: "„Generalstäbler“ Sander",
      umschlagBestaetigt: true,
      kolumne: K("„Generalstäbler“ Sander"),
      reihe: "Weltkrieg Originalband",
      nummer: "327",
    });
    expect(e).toEqual({ titel: "„Generalstäbler“ Sander", quelle: "beide" });
  });
  it("vergleicht ohne Satzzeichen und ß", () => {
    expect(titelSchluessel("„Das alles wegen zweier Brücken!“")).toBe(titelSchluessel("Das alles wegen zweier Brücken…!"));
    expect(titelSchluessel("Doppelschuß Rot")).toBe(titelSchluessel("DOPPELSCHUSS ROT"));
  });
  it("entscheidet bei Widerspruch nicht still: gedruckter Titel bleibt, Vermerk mit beiden", () => {
    const e = titelEntscheiden({
      umschlag: "Sanitäter Franz Schmitz",
      umschlagBestaetigt: true,
      kolumne: K("Oberfeldwebel Franz Schmitz"),
      reihe: "Weltkrieg Soldaten",
      nummer: "40",
    });
    expect(e.titel).toBe("Sanitäter Franz Schmitz");
    expect(e.pruefen).toEqual({
      umschlag: "Sanitäter Franz Schmitz",
      kolumne: "Oberfeldwebel Franz Schmitz",
      grund: "Titelseite und Kolumnentitel weichen ab",
    });
  });
  it("schreibt wie der Kolumnentitel, wenn die Titelseite nur geraten ist", () => {
    // Dieselben Buchstaben, aber zerstueckelt: einig, gesetzt ist der Kopf.
    const e = titelEntscheiden({
      umschlag: "Bombenk Rieg in de R Bocage",
      umschlagBestaetigt: false,
      kolumne: K("Bombenkrieg in der Bocage"),
      reihe: "Weltkrieg Doppelband",
    });
    expect(e).toEqual({ titel: "Bombenkrieg in der Bocage", quelle: "beide" });
  });
  it("nimmt den Kolumnentitel mit Vermerk, wenn eine geratene Titelseite widerspricht", () => {
    const e = titelEntscheiden({
      umschlag: "Doppelschuss R0t",
      umschlagBestaetigt: false,
      kolumne: K("Doppelschuß Rot"),
      reihe: "Weltkrieg Großband",
    });
    expect(e.titel).toBe("Doppelschuß Rot");
    expect(e.quelle).toBe("kolumne");
    expect(e.pruefen?.grund).toBe("Titelseite und Kolumnentitel weichen ab");
  });
  it("nimmt im Sammelheft den Aufmacher, nicht den haeufigsten Artikel", () => {
    const e = titelEntscheiden({
      umschlag: "Mit dem Rücken zur Wand",
      umschlagBestaetigt: true,
      kolumne: MAGAZIN,
      reihe: "Weltkrieg Magazin",
      nummer: "7",
    });
    expect(e).toEqual({ titel: "Mit dem Rücken zur Wand", quelle: "umschlag" });
  });
  it("nennt ein Sammelheft ohne Titel auf der Titelseite nach der Nummer", () => {
    const e = titelEntscheiden({ umschlag: null, umschlagBestaetigt: false, kolumne: MAGAZIN, reihe: "Weltkrieg Magazin", nummer: "7" });
    expect(e).toEqual({ titel: "Magazin Nr. 7", quelle: "nummer" });
  });
  it("schlaegt im Sammelheft den Artikel mit denselben Woertern vor", () => {
    const e = titelEntscheiden({
      umschlag: "Zum Westwall Zurück",
      umschlagBestaetigt: false,
      kolumne: K("Fregattenkapitän Klaus Scholtz", 23, [
        { text: "Fregattenkapitän Klaus Scholtz", anzahl: 23 },
        { text: "Die Hölle an der Kertsch-Front", anzahl: 9 },
        { text: "Zurück zum Westwall", anzahl: 9 },
        { text: "Mit Ritter von Heigl in Eupatoria", anzahl: 9 },
      ]),
      reihe: "Weltkrieg Magazin",
      nummer: "73",
    });
    expect(e.titel).toBe("Zum Westwall Zurück");
    expect(e.pruefen?.kolumne).toBe("Zurück zum Westwall");
  });
  it("vermerkt, wenn nur eine Quelle den Titel kennt", () => {
    const nurKopf = titelEntscheiden({ umschlag: null, umschlagBestaetigt: false, kolumne: K("Blutiger Januar"), reihe: "Freikorps" });
    expect(nurKopf.titel).toBe("Blutiger Januar");
    expect(nurKopf.pruefen?.grund).toMatch(/Titelseite/);
    const nurUmschlag = titelEntscheiden({ umschlag: "Blutiger Januar", umschlagBestaetigt: true, kolumne: null, reihe: "Freikorps" });
    expect(nurUmschlag.titel).toBe("Blutiger Januar");
    expect(nurUmschlag.pruefen?.grund).toMatch(/Kolumnentitel/);
  });
});
