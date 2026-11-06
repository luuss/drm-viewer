import { afterEach, describe, expect, test, vi } from "vitest";
import { ladenArt, ladenProdukt, ladenSuche, ladenUrl, ladenWarenkorb } from "./laden";
import { standardShopApiUrl } from "./shopApi";
import { issueShopLink } from "./shopLinks";
import { searchUrl, seriesUrl } from "./pageLinks";

afterEach(() => vi.unstubAllEnvs());

describe("Laden der Anlage", () => {
  test("ohne Angabe: Lesen und Schenken (PrestaShop)", () => {
    vi.stubEnv("LADEN", "");
    vi.stubEnv("SHOP_BASIS_URL", "");
    expect(ladenArt()).toBe("prestashop");
    expect(ladenUrl()).toBe("https://lesenundschenken.de");
    expect(ladenSuche("DMZ 170")).toBe("https://lesenundschenken.de/suche?s=DMZ%20170");
    expect(ladenWarenkorb()).toBe("https://lesenundschenken.de/module/lusdigital/warenkorb");
    expect(standardShopApiUrl()).toBe("https://lesenundschenken.de/module/lusdigital/api");
    expect(ladenProdukt(42)).toBe("https://lesenundschenken.de/index.php?controller=product&id_product=42");
  });

  test("Weltkrieg: WooCommerce auf weltkrieg-online.de", () => {
    vi.stubEnv("LADEN", "woocommerce");
    vi.stubEnv("SHOP_BASIS_URL", "https://weltkrieg-online.de/");
    expect(ladenUrl()).toBe("https://weltkrieg-online.de");
    expect(ladenSuche("Originalband 330")).toBe(
      "https://weltkrieg-online.de/?s=Originalband%20330&post_type=product",
    );
    expect(ladenWarenkorb()).toBe("https://weltkrieg-online.de/?wkdigital-warenkorb=1");
    expect(standardShopApiUrl()).toBe("https://weltkrieg-online.de/wp-json/wkdigital/v1/api");
    expect(ladenProdukt(8535)).toBe("https://weltkrieg-online.de/?post_type=product&p=8535");
    expect(searchUrl("Tankgewehr")).toBe("https://weltkrieg-online.de/?s=Tankgewehr&post_type=product");
    expect(seriesUrl("weltkrieg-originalband")).toBe(
      "https://weltkrieg-online.de/produkt-kategorie/weltkrieg-originalband/",
    );
    // "Im Laden kaufen" ohne eingetragene Produktseite: die Suche im eigenen Laden.
    expect(issueShopLink({ title: "Der hungrige Tod", issueNumber: "254" }, "Weltkrieg Originalband")).toBe(
      "https://weltkrieg-online.de/?s=Weltkrieg%20Originalband%20254&post_type=product",
    );
  });
});
