/**
 * Buchflaechen eines Stands gegen den Laden pruefen, ohne etwas zu schreiben.
 *
 *   npx esbuild tools/buchzuordnung_sim.ts --bundle --platform=node --format=esm \
 *     --outfile=_scratch/buchzuordnung/sim.mjs
 *   node _scratch/buchzuordnung/sim.mjs <stand-ordner> <userId eines Redakteurs>
 *
 * Liest die Ausgabe von tools/buchzuordnung_dump.sh, fragt den Laden ueber
 * die Redaktionssuche (`articleProducts:searchShop`, Zwischenspeicher in
 * <stand-ordner>/../shop-cache.json) und rechnet je Flaeche aus, wohin die
 * Aufloesung mit dem Code dieses Stands fuehrt. Vergleicht mit dem Ziel live.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BOOK_LABEL_SEPARATOR,
  bookQueries,
  chooseBook,
  chooseFromAd,
  openBookTarget,
  textUnderLink,
} from "../convex/pageLinks";
import type { ShopProduct } from "../convex/shopApi";

const [dir, userId] = process.argv.slice(2);
const base = dirname(dir.replace(/\/$/, ""));
const cachePath = join(base, "shop-cache.json");
const cache: Record<string, ShopProduct[]> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};
const env = process.env.ENV_FILE ?? "_scratch/verlag-direkt.env";

function search(q: string): ShopProduct[] {
  if (!cache[q]) {
    const out = execFileSync(
      "npx",
      [
        "convex", "run", "--env-file", env,
        "--identity", JSON.stringify({ subject: `${userId}|x`, issuer: "x" }),
        "articleProducts:searchShop", JSON.stringify({ q }),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const rows = JSON.parse(out) as any[];
    cache[q] = rows.map((r) => ({
      id: r.productId,
      name: r.name,
      reference: r.reference,
      manufacturer: r.manufacturer ?? "",
      url: r.url,
      priceCents: r.priceCents ?? null,
      active: r.active,
    })) as ShopProduct[];
    writeFileSync(cachePath, JSON.stringify(cache));
  }
  return cache[q];
}

const issues = JSON.parse(readFileSync(join(base, "issues.json"), "utf8")) as any[];
// Mit PLAN=<datei>: die Flaechen, deren Ziel sich auf eine Produktseite
// aendert, samt altem Ziel (fuer `pageLinks:setFieldsInternal` und zurueck).
const plan: { id: string; issue: string; label: string; vorher: string | null; gespeichert: string | null; neu: string }[] = [];
const stats = { produkt: 0, suche: 0, nirgends: 0, ausAnzeige: 0, geaendert: 0 };
for (const issue of issues) {
  const file = join(dir, `${issue._id}.pageLinks_listForEditors.json`);
  if (!existsSync(file)) continue;
  const links = JSON.parse(readFileSync(file, "utf8")) as any[];
  const arts = JSON.parse(
    readFileSync(join(dir, `${issue._id}.articles_listForEditors.json`), "utf8"),
  ) as any[];
  const aps = JSON.parse(
    readFileSync(join(dir, `${issue._id}.articleProducts_listForEditors.json`), "utf8"),
  ) as any[];
  const anzeige = (l: any): ShopProduct[] => {
    const ids = new Set<string>();
    for (const a of arts) {
      for (const r of a.regions) {
        if (r.pageIndex !== l.pageIndex || r.targetPageIndex != null) continue;
        if (textUnderLink(r, l)) ids.add(a._id);
      }
    }
    return aps
      .filter((x) => x.product && ids.has(x.articleId))
      .map((x) => ({ ...x.product, id: x.product.productId, manufacturer: "", coverUrl: null, digital: null }));
  };
  for (const l of links) {
    if (l.kind !== "shop" || !l.label?.includes(BOOK_LABEL_SEPARATOR)) continue;
    const products: ShopProduct[] = [];
    for (const q of bookQueries(l.label, l.reference, l.queries)) products.push(...search(q));
    let book = chooseBook(products, l.label, l.reference);
    if (!book) {
      book = chooseFromAd(anzeige(l), l.label, l.reference);
      if (book) stats.ausAnzeige++;
    }
    const aehnlich = openBookTarget(products, l.label) !== undefined;
    const live = (l.target ?? "").replace("https://lesenundschenken.de", "");
    const neu = book
      ? book.url.replace("https://lesenundschenken.de", "")
      : aehnlich
        ? "(Suche)"
        : "(nicht im Laden)";
    if (book) stats.produkt++;
    else if (aehnlich) stats.suche++;
    else stats.nirgends++;
    const anders = (live.includes("/suche?") ? "(Suche)" : live) !== neu;
    if (anders) stats.geaendert++;
    if (anders && book) {
      plan.push({
        id: l._id,
        issue: issue._id,
        label: l.label,
        vorher: l.target ?? null,
        gespeichert: l.url ?? null,
        neu: book.url,
      });
    }
    if (anders || !book || process.env.ALLE) {
      console.log(
        `${anders ? "*" : " "} ${issue.title.slice(0, 14).padEnd(14)} S${String(l.pageIndex).padStart(3)} ${JSON.stringify(l.label).slice(0, 70).padEnd(70)} live ${live.slice(0, 50).padEnd(50)} neu ${neu.slice(0, 60)}` +
          (book ? "" : `  [${[...new Set(products.map((p) => p.name))].slice(0, 4).join(" | ")}]`),
      );
    }
  }
}
console.log(stats);
if (process.env.PLAN) writeFileSync(process.env.PLAN, JSON.stringify(plan, null, 2));
