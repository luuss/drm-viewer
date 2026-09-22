/**
 * Aus den Quellen eines Hefts die Leserreihenfolge vorschlagen.
 *
 * Ein Umschlag kommt aus der Druckvorstufe in einer von drei Formen, und die
 * Seitenzahl der Datei verraet meist welche. Dieses Modul rechnet nur; was am
 * Ende gilt, bestaetigt die Redaktion im Importdialog.
 */

export type PageRole =
  | "front_cover"
  | "inside_front"
  | "content"
  | "inside_back"
  | "back_cover"
  | "other";

export type PageDraft<Asset = string> = {
  sourceAssetId: Asset;
  sourcePageIndex: number;
  /** Nur bei Umschlag-Doppelseiten: welche Haelfte die Leserseite ist. */
  sourceHalf?: "left" | "right";
  role: PageRole;
  printedLabel?: string;
};

/**
 * sheets:  vier Einzelseiten in Bogenreihenfolge (U4, U1, U2, U3)
 * spreads: zwei Doppelseiten (U4|U1, U2|U3), gelesen als Haelften
 * reading: Einzelseiten bereits in Leserreihenfolge (U1 ... U4)
 * auto:    nach Seitenzahl der Datei entscheiden (2 -> spreads, 4 -> sheets)
 */
export type CoverLayout = "auto" | "sheets" | "spreads" | "reading";

export type OrderInput<Asset = string> = {
  inner: { assetId: Asset; pageCount: number };
  /** Umschlag als PDF, falls vorhanden. */
  cover?: { assetId: Asset; pageCount: number };
  /** Titelseite als Bild — dann gibt es nur U1, kein Umschlagbogen. */
  coverImageAssetId?: Asset;
  layout?: CoverLayout;
  printedStart?: number;
};

export function resolveLayout(
  layout: CoverLayout | undefined,
  coverPageCount: number | undefined,
): Exclude<CoverLayout, "auto"> {
  if (layout && layout !== "auto") return layout;
  if (coverPageCount === 2) return "spreads";
  if (coverPageCount === 4) return "sheets";
  return "reading";
}

export function buildPageOrder<Asset = string>({
  inner,
  cover,
  coverImageAssetId,
  layout,
  printedStart = 3,
}: OrderInput<Asset>): PageDraft<Asset>[] {
  const draft: PageDraft<Asset>[] = [];
  const form = resolveLayout(layout, cover?.pageCount);
  const spreads = !!cover && form === "spreads" && cover.pageCount >= 2;
  const sheets = !!cover && form === "sheets" && cover.pageCount === 4;

  if (cover && spreads) {
    // Erster Bogen: links U4, rechts U1. Zweiter Bogen: links U2, rechts U3.
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, sourceHalf: "right", role: "front_cover", printedLabel: "U1" });
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 1, sourceHalf: "left", role: "inside_front", printedLabel: "U2" });
  } else if (cover && sheets) {
    // Bogenreihenfolge U4, U1, U2, U3 -> Lesereihenfolge.
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 1, role: "front_cover", printedLabel: "U1" });
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 2, role: "inside_front", printedLabel: "U2" });
  } else if (cover) {
    if (cover.pageCount >= 1) {
      draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, role: "front_cover", printedLabel: "U1" });
    }
  } else if (coverImageAssetId !== undefined) {
    // Eine Titelseite als Bild ist genau eine Seite: U1.
    draft.push({ sourceAssetId: coverImageAssetId, sourcePageIndex: 0, role: "front_cover", printedLabel: "U1" });
  }

  for (let i = 0; i < inner.pageCount; i++) {
    draft.push({
      sourceAssetId: inner.assetId,
      sourcePageIndex: i,
      role: "content",
      printedLabel: String(printedStart + i),
    });
  }

  if (cover && spreads) {
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 1, sourceHalf: "right", role: "inside_back", printedLabel: "U3" });
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, sourceHalf: "left", role: "back_cover", printedLabel: "U4" });
  } else if (cover && sheets) {
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 3, role: "inside_back", printedLabel: "U3" });
    draft.push({ sourceAssetId: cover.assetId, sourcePageIndex: 0, role: "back_cover", printedLabel: "U4" });
  } else if (cover && cover.pageCount > 1) {
    draft.push({
      sourceAssetId: cover.assetId,
      sourcePageIndex: cover.pageCount - 1,
      role: "back_cover",
      printedLabel: "U4",
    });
  }

  return draft;
}
