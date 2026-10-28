import { describe, expect, it } from "vitest";
import { aufteilen } from "./folderDrop";

const datei = (path: string) => ({
  path,
  name: path.split("/").pop()!,
  size: 1,
  file: new File([], path.split("/").pop()!),
});

describe("aufteilen", () => {
  it("laesst einen Heftordner mit PDFs obenauf zusammen", () => {
    const ordner = { folderName: "zuerst 11-2025", files: [datei("innen.pdf"), datei("Links/a.jpg")] };
    expect(aufteilen(ordner)).toEqual([ordner]);
  });

  it("teilt einen Sammelordner in seine Heftordner, nach Nummer sortiert", () => {
    const hefte = aufteilen({
      folderName: "Hefte",
      files: [
        datei("zuerst 10-2025/innen.pdf"),
        datei("zuerst 10-2025/Links/a.jpg"),
        datei("zuerst 9-2025/innen.pdf"),
        datei("notizen/liesmich.txt"),
      ],
    });
    expect(hefte.map((h) => h.folderName)).toEqual(["zuerst 9-2025", "zuerst 10-2025"]);
    expect(hefte[1].files.map((f) => f.path)).toEqual(["innen.pdf", "Links/a.jpg"]);
  });

  it("bleibt beim Ordner, wenn kein Heft darin erkennbar ist", () => {
    const ordner = { folderName: "leer", files: [datei("x/y.txt")] };
    expect(aufteilen(ordner)).toEqual([ordner]);
  });
});
