import { describe, expect, test } from "vitest";
import {
  coverCandidates,
  designationMatches,
  parseMagazineStrip,
  parsePrice,
  parseProductCards,
  parseProductPage,
  searchQueryForIssue,
  seriesFor,
} from "./shopCovers";

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

// Nachbau einer Produktkarte der Kategorie- und Suchseiten.
const CARD = `
<article class="product-miniature js-product-miniature" data-id-product="10491">
  <div class="thumbnail-top"><a href="https://lesenundschenken.de/10491-fernspaher.html" class="thumbnail product-thumbnail">
    <picture><img src="https://lesenundschenken.de/8736-medium_default/fernspaher.jpg" alt="Fernspäher" loading="lazy"
      data-full-size-image-url="https://lesenundschenken.de/8736-large_default/fernspaher.jpg" width="452" height="452" /></picture></a></div>
  <div class="product-description">
    <h2 class="h3 product-title"><a href="https://lesenundschenken.de/10491-fernspaher.html">Fernsp&auml;her</a></h2>
    <span class="lus-mini-author">DMZ Nr. 170</span>
    <span class="lus-mini-ref">Art.-Nr. 451459</span>
  </div>
</article>
<article class="product-miniature"><h2 class="h3 product-title"><a href="https://lesenundschenken.de/10490-zuerst.html">ZUERST!</a></h2>
  <span class="lus-mini-author">März 2026</span></article>`;

// Nachbau des Kopfs einer Produktseite.
const PAGE = `<html><head><title>Mscha 1943</title></head><body>
<div class="lus-product-head">
  <h1 class="h1">Mscha 1943</h1>
  <div class="lus-head-author">DMZ-ZG Nr. 80</div>
  <div class="lus-head-sub lus-untertitel">Ausgabe März/April 2026</div>
  <div class="lus-head-pages">68 Seiten</div>
  <div class="lus-head-fmt lus-format">A4</div>
</div></body></html>`;

describe("Heftbezeichnungen aus dem Verlagsshop", () => {
  test("Produktkarten liefern Name, Heftbezeichnung, Bildnummer und Adresse", () => {
    const cards = parseProductCards(CARD);
    expect(cards).toEqual([
      { name: "Fernspäher", designation: "DMZ Nr. 170", imageId: "8736", url: "https://lesenundschenken.de/10491-fernspaher.html" },
      { name: "ZUERST!", designation: "März 2026", imageId: null, url: "https://lesenundschenken.de/10490-zuerst.html" },
    ]);
  });

  test("liest den Einzelpreis aus der Auszeichnung des Ladens", () => {
    // So schreibt der Laden ihn aus; gemessen an der Seite des Greim-Heftes.
    expect(parsePrice('<meta itemprop="price" content="13.8" />')).toBe(1380);
    expect(parsePrice('<span itemprop="price" content="8,70">8,70 €</span>')).toBe(870);
    expect(parsePrice("<p>kein Preis</p>")).toBeNull();
    expect(parsePrice('<meta itemprop="price" content="0" />')).toBeNull();
  });

  test("die Produktseite liefert Name, Heftbezeichnung und Unter-Ueberschrift", () => {
    expect(parseProductPage(PAGE)).toEqual({
      name: "Mscha 1943",
      designation: "DMZ-ZG Nr. 80",
      subtitle: "Ausgabe März/April 2026",
      priceCents: null,
      pages: "68 Seiten",
    });
    expect(parseProductPage("<html><body>nichts</body></html>")).toBeNull();
  });

  test("Suchbegriffe folgen der Heftbezeichnung der Reihe", () => {
    expect(searchQueryForIssue(seriesFor("dmz")!, "170")).toBe("DMZ Nr. 170");
    expect(searchQueryForIssue(seriesFor("dmz-zeitgeschichte")!, "80")).toBe("DMZ-ZG Nr. 80");
    expect(searchQueryForIssue(seriesFor("schwertertraeger")!, "36")).toBe("Schwerterträger Heft 36");
    expect(searchQueryForIssue(seriesFor("zuerst")!, "3/2026")).toBe("ZUERST! März 2026");
    expect(searchQueryForIssue(seriesFor("zuerst")!, "7-8/2026")).toBe("ZUERST! Juli 2026");
    expect(searchQueryForIssue(seriesFor("zuerst")!, "Sonderheft")).toBeNull();
  });

  test("nur die genaue Nummer oder der genaue Monat gilt als Treffer", () => {
    const dmz = seriesFor("dmz")!;
    expect(designationMatches(dmz, "DMZ Nr. 170", "170")).toBe(true);
    expect(designationMatches(dmz, "DMZ Nr. 1700", "170")).toBe(false);
    expect(designationMatches(seriesFor("schwertertraeger")!, "Schwerterträger Heft 36", "36")).toBe(true);
    const zuerst = seriesFor("zuerst")!;
    expect(designationMatches(zuerst, "März 2026", "3/2026")).toBe(true);
    expect(designationMatches(zuerst, "März 2025", "3/2026")).toBe(false);
    expect(designationMatches(zuerst, "Juli/August 2026", "7-8/2026")).toBe(true);
    expect(designationMatches(zuerst, "Juli/August 2026", "8/2026")).toBe(true);
  });
});
