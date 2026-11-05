import { describe, expect, test } from "vitest";
import { verzeichnisHtml } from "./zuerstDirectus";

describe("verzeichnisHtml", () => {
  test("Rubrik einmal, nur Eintraege mit Unterzeile, ZUERST! kursiv, maskiert", () => {
    const { html, anzahl } = verzeichnisHtml([
      { rubrik: null, titel: "Editorial", unterzeile: null },
      { rubrik: "Titel", titel: "Was will die AfD wirklich?", unterzeile: "Wie Altparteien <irren>" },
      { rubrik: "Titel", titel: "„Hysterisierung“", unterzeile: "Brandner im ZUERST!-Gespräch" },
      { rubrik: "Deutschland", titel: "Innere Sicherheit", unterzeile: "" },
      { rubrik: "gesellschaft", titel: "Entthronter Clown", unterzeile: "Das ZDF & Böhmermann" },
    ]);
    expect(anzahl).toBe(3);
    expect(html).toBe(
      [
        "<h2>TITEL</h2>",
        '<p style="padding-left: 30px;"><strong>Was will die AfD wirklich?</strong><br>Wie Altparteien &lt;irren&gt;</p>',
        '<p style="padding-left: 30px;"><strong>„Hysterisierung“</strong><br>Brandner im <em>ZUERST!</em>-Gespräch</p>',
        "<h2>GESELLSCHAFT</h2>",
        '<p style="padding-left: 30px;"><strong>Entthronter Clown</strong><br>Das ZDF &amp; Böhmermann</p>',
      ].join("\n"),
    );
  });
});
