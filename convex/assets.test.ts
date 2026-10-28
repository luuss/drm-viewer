/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("Stand eines Bildes fuer das Kachel-Gateway", () => {
  test("ein Neuimport unter demselben Schluessel aendert den Stand", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 28, 10, 0)));
    const t = convexTest(schema, modules);
    const bild = {
      key: "issues/x/images/12-0.1-0.2.jpg",
      bucket: "emag-media",
      contentType: "image/jpeg",
      kind: "image" as const,
    };
    const assetId = await t.mutation(internal.assets.createInternal, { ...bild, bytes: 41_000 });
    const vorher = await t.query(internal.assets.resolveForServiceInternal, { assetId });

    // Derselbe Schluessel, andere Datei: die Kennung bleibt, der Stand nicht.
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 29, 10, 0)));
    const wieder = await t.mutation(internal.assets.createInternal, { ...bild, bytes: 41_000 });
    expect(wieder).toBe(assetId);
    const nachher = await t.query(internal.assets.resolveForServiceInternal, { assetId });
    expect(nachher?.key).toBe(vorher?.key);
    expect(nachher?.stand).not.toBe(vorher?.stand);
    vi.useRealTimers();
  });
});
