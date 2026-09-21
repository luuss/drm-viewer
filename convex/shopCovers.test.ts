import { describe, expect, test } from "vitest";
import { coverCandidates, parseMagazineStrip } from "./shopCovers";

// Nachbau der Zeitschriften-Leiste unten auf lesenundschenken.de.
const STRIP = `
<div class="lus-magazines-wrap"><h2 class="lus-mag-heading">Zeitschriften</h2>
<ul class="lus-mag-list">
<li class="lus-mag-item"><a href="https://lesenundschenken.de/1327-zuerst" class="lus-mag-link">
  <img src="https://lesenundschenken.de/9910-home_default/zuerst.jpg" alt="ZUERST! &ndash; ZUERST!" loading="lazy"></a></li>
<li class="lus-mag-item"><a href="https://lesenundschenken.de/1328-dmz">
  <img alt="DMZ – Der Schild Japans" src="https://lesenundschenken.de/9909-home_default/der-schild-japans.jpg"></a></li>
<li class="lus-mag-item"><a href="https://lesenundschenken.de/1329-dmz-zeitgeschichte">
  <img src="https://lesenundschenken.de/9902-home_default/pulkowo-1941.jpg" alt="DMZ Zeitgeschichte – Pulkowo 1941"></a></li>
<li class="lus-mag-item"><a href="https://lesenundschenken.de/10719-festung-breslau-1945.html">
  <img src="https://lesenundschenken.de/8803-home_default/festung-breslau-1945.jpg" alt="DMZ Zeitgeschichte extra – Festung Breslau 1945"></a></li>
<li class="lus-mag-item"><a href="https://lesenundschenken.de/1330-schwertertrager">
  <img src="https://lesenundschenken.de/8829-home_default/friedrich-schulz.jpg" alt="Schwerterträger – Friedrich Schulz"></a></li>
<li class="lus-mag-item"><a href="https://lesenundschenken.de/1331-der-schlesier">
  <img src="https://lesenundschenken.de/8702-home_default/der-schlesier.jpg" alt="Der Schlesier – Der Schlesier"></a></li>
</ul></div>`;

describe("Titelbilder aus dem Verlagsshop", () => {
  test("die Leiste nennt je Reihe die aktuelle Ausgabe und ihre Bildnummer", () => {
    const entries = parseMagazineStrip(STRIP);
    expect(entries.map((e) => [e.shopSlug, e.slug, e.imageId, e.label])).toEqual([
      ["zuerst", "zuerst", "9910", "ZUERST!"],
      ["dmz", "dmz", "9909", "Der Schild Japans"],
      ["dmz-zeitgeschichte", "dmz-zeitgeschichte", "9902", "Pulkowo 1941"],
      // Das Sonderheft verweist auf ein Produkt (.html), nicht auf eine Reihe.
      ["schwertertrager", "schwertertraeger", "8829", "Friedrich Schulz"],
      ["der-schlesier", null, "8702", "Der Schlesier"],
    ]);
  });

  test("das grosse Bild: Original unter img/p, ersatzweise large_default", () => {
    expect(coverCandidates({ imageId: "9910", imageName: "zuerst" })).toEqual([
      "https://lesenundschenken.de/img/p/9/9/1/0/9910.jpg",
      "https://lesenundschenken.de/9910-large_default/zuerst.jpg",
    ]);
  });

  test("ohne Leiste gibt es keine Eintraege", () => {
    expect(parseMagazineStrip("<html><body>nichts</body></html>")).toEqual([]);
  });
});
