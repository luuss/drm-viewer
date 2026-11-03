import { describe, expect, it } from "vitest";
import { aufteilen, zusammenfuehren } from "./folderDrop";

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

  it("teilt keinen Heftordner, dessen PDFs in Unterordnern liegen", () => {
    const ordner = {
      folderName: "zuerst 11-2025",
      files: [datei("zuerst.idml"), datei("PDF/innen.pdf"), datei("Umschlag/umschlag.pdf")],
    };
    expect(aufteilen(ordner)).toEqual([ordner]);
  });

  it("teilt keinen Ordner mit Innenteil und Umschlag als Unterordnern", () => {
    const ordner = {
      folderName: "dmz 170",
      files: [datei("Innenteil/innen.pdf"), datei("Umschlag/umschlag.pdf")],
    };
    expect(aufteilen(ordner)).toEqual([ordner]);
  });

  it("bleibt beim Ordner, wenn kein Heft darin erkennbar ist", () => {
    const ordner = { folderName: "leer", files: [datei("x/y.txt")] };
    expect(aufteilen(ordner)).toEqual([ordner]);
  });
});

describe("zusammenfuehren", () => {
  it("haengt Bilderordner und lose IDML an das Heft", () => {
    const hefte = zusammenfuehren(
      [
        { folderName: "zuerst 8-9-2025", files: [datei("innen.pdf")] },
        { folderName: "bilder 8-9-2025", files: [datei("a.jpg"), datei("b.tif")] },
      ],
      [datei("zuerst 8-9.idml")],
    );
    expect(hefte).toHaveLength(1);
    expect(hefte[0].folderName).toBe("zuerst 8-9-2025");
    expect(hefte[0].files.map((f) => f.path)).toEqual([
      "innen.pdf",
      "bilder 8-9-2025/a.jpg",
      "bilder 8-9-2025/b.tif",
      "zuerst 8-9.idml",
    ]);
  });

  it("ordnet Bilderordner bei mehreren Heften nach Heftnummer zu", () => {
    const hefte = zusammenfuehren([
      { folderName: "zuerst 7-2025", files: [datei("innen.pdf")] },
      { folderName: "zuerst 8-9-2025", files: [datei("innen.pdf")] },
      { folderName: "bilder 8-9-2025", files: [datei("a.jpg")] },
    ]);
    expect(hefte.map((h) => h.files.length)).toEqual([1, 2]);
  });
});

describe("lose PDFs ohne Ordner", () => {
  const datei = (name: string) => ({ path: name, name, size: 1, file: new Blob() as File });
  it("macht aus jedem PDF ein Heft mit dem Dateinamen", () => {
    const hefte = zusammenfuehren([], [datei("Originalband 12.pdf"), datei("Flieger 3.pdf")]);
    expect(hefte.map((h) => h.folderName)).toEqual(["Originalband 12.pdf", "Flieger 3.pdf"]);
    expect(hefte[1].files.map((f) => f.name)).toEqual(["Flieger 3.pdf"]);
  });
  it("nimmt bei einem PDF die anderen losen Dateien mit", () => {
    const hefte = zusammenfuehren([], [datei("Marine 7.pdf"), datei("Marine 7.idml")]);
    expect(hefte).toHaveLength(1);
    expect(hefte[0].files.map((f) => f.name)).toEqual(["Marine 7.pdf", "Marine 7.idml"]);
  });
  it("ordnet Begleitdateien bei mehreren PDFs nach Name zu", () => {
    const hefte = zusammenfuehren([], [
      datei("Marine 7.pdf"),
      datei("Flieger 3.pdf"),
      datei("Flieger 3.idml"),
      datei("marine 7.jpg"),
    ]);
    expect(hefte.map((h) => h.files.map((f) => f.name))).toEqual([
      ["Marine 7.pdf", "marine 7.jpg"],
      ["Flieger 3.pdf", "Flieger 3.idml"],
    ]);
  });
});
