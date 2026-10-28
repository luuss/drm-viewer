#!/usr/bin/env python3
"""Einen Importauftrag lokal durchspielen, ohne Convex und ohne Medienspeicher.

Der echte Worker (`worker.Job`) laeuft unveraendert; ersetzt werden nur die
beiden Anschluesse nach aussen: das Backend nimmt alles an und merkt es sich,
der Speicher liest aus einem lokalen Ordner und legt die Artikelbilder dort ab.
So laesst sich eine Aenderung an der Erkennung am ganzen Heft pruefen, bevor
sie ausgerollt wird — und zwei Staende lassen sich vergleichen.

Aufruf:
    .venv/bin/python tools/probelauf.py <heftordner> <speicher> <ausgabe>

* `<heftordner>/auftrag.json`: die Auftragsdaten, wie `imports.claimNextInternal`
  sie dem Worker gibt (Quellen mit `assetKey`, Seiten mit `previewKey`).
* `<speicher>`: Objekte des Medienspeichers unter ihrem Schluessel als Pfad.
* `<ausgabe>`: `ergebnis.json` (Artikel, Bloecke, Bilder, Verzeichnis,
  Seitenlinks, Heftangaben), `artikel.txt` zum Lesen, `bilder/` mit den
  Ausschnitten.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import worker  # noqa: E402
from storage import StoredObject  # noqa: E402


class LokalerSpeicher:
    uses_s3 = True

    def __init__(self, wurzel: str, ausgabe: str) -> None:
        self.wurzel = wurzel
        self.ausgabe = ausgabe

    def get(self, key: str) -> bytes:
        with open(os.path.join(self.wurzel, key), "rb") as f:
            return f.read()

    def put(self, key: str, data: bytes, content_type: str) -> StoredObject:
        ziel = os.path.join(self.ausgabe, "bilder", key.replace("/", "__"))
        os.makedirs(os.path.dirname(ziel), exist_ok=True)
        with open(ziel, "wb") as f:
            f.write(data)
        return StoredObject(key, "lokal", None, len(data))


class LokalesBackend:
    """Nimmt jeden Aufruf an; merkt sich Ergebnis, Heftangaben und Bilder."""

    def __init__(self) -> None:
        self.ergebnis: dict | None = None
        self.heft: dict = {}
        self.assets: dict[str, dict] = {}
        self.aufrufe: list[str] = []

    def post(self, path: str, body: dict):
        self.aufrufe.append(path)
        if path == "/service/jobs/heartbeat":
            return {"ok": True}
        if path == "/service/assets/register":
            asset_id = f"asset{len(self.assets) + 1}"
            self.assets[asset_id] = body
            return asset_id
        if path == "/service/jobs/result":
            self.ergebnis = body
            return {"articles": len(body.get("articles", []))}
        if path == "/service/issue/counts":
            self.heft.update({k: v for k, v in body.items() if k != "issueId"})
            return {}
        if path == "/service/jobs/articles":
            return []
        return {}

    def download(self, url: str, max_bytes: int) -> bytes:
        raise RuntimeError(f"Kein Netz im Probelauf: {url}")


def _bildschluessel(backend: LokalesBackend, asset_id: str) -> str | None:
    return (backend.assets.get(asset_id) or {}).get("key")


def zusammenfassen(backend: LokalesBackend) -> dict:
    erg = backend.ergebnis or {}
    artikel = []
    for a in erg.get("articles", []):
        artikel.append(
            {
                "nr": a.get("order"),
                "titel": a.get("title"),
                "untertitel": a.get("subtitle"),
                "autor": a.get("author"),
                "teaser": a.get("teaser"),
                "seiten": [a.get("pageStart"), a.get("pageEnd")],
                "bloecke": [
                    {k: b.get(k) for k in ("type", "text", "sourcePageIndex", "sourceY")}
                    for b in a.get("blocks", [])
                ],
                "bilder": [
                    {
                        "datei": _bildschluessel(backend, i["assetId"]),
                        "unterschrift": i.get("caption"),
                        "seite": i.get("sourcePageIndex"),
                        "y": i.get("sourceY"),
                        "nachAbsatz": i.get("afterBlockOrder"),
                    }
                    for i in a.get("images", [])
                ],
                "flaechen": len(a.get("regions", [])),
            }
        )
    return {
        "artikel": artikel,
        "verzeichnis": erg.get("tocEntries", []),
        "seitenlinks": erg.get("pageLinks", []),
        "heft": backend.heft,
    }


def lesbar(zusammenfassung: dict) -> str:
    zeilen = []
    for a in zusammenfassung["artikel"]:
        zeilen.append(
            f"#{a['nr']} S.{a['seiten'][0]}-{a['seiten'][1]} {a['titel']!r}"
            + (f" | Unterzeile {a['untertitel']!r}" if a["untertitel"] else "")
            + (f" | Autor {a['autor']!r}" if a["autor"] else "")
        )
        for b in a["bloecke"]:
            zeilen.append(f"    [{b['type']}] {b['text'][:160]}")
        for i in a["bilder"]:
            zeilen.append(
                f"    <Bild S.{i['seite']} y={i['y']} nach={i['nachAbsatz']}> "
                f"{(i['unterschrift'] or '')[:120]!r} {os.path.basename(i['datei'] or '')}"
            )
    zeilen.append("")
    zeilen.append("Verzeichnis:")
    for t in zusammenfassung["verzeichnis"]:
        zeilen.append(
            f"  {t.get('order')} S.{t.get('pageIndex')} {t.get('label')!r} "
            f"-> Artikel {t.get('articleOrder')} [{t.get('section') or ''}]"
        )
    zeilen.append(f"Heft: {zusammenfassung['heft']}")
    return "\n".join(zeilen) + "\n"


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    heftordner, speicher, ausgabe = sys.argv[1:]
    os.makedirs(ausgabe, exist_ok=True)
    with open(os.path.join(heftordner, "auftrag.json"), encoding="utf-8") as f:
        auftrag = json.load(f)
    backend = LokalesBackend()
    job = worker.Job(backend, LokalerSpeicher(speicher, ausgabe), auftrag)
    start = time.time()
    status, meldung = job.run()
    z = zusammenfassen(backend)
    z["status"] = status
    z["meldung"] = meldung
    z["sekunden"] = round(time.time() - start, 1)
    with open(os.path.join(ausgabe, "ergebnis.json"), "w", encoding="utf-8") as f:
        json.dump(z, f, ensure_ascii=False, indent=1)
    with open(os.path.join(ausgabe, "artikel.txt"), "w", encoding="utf-8") as f:
        f.write(lesbar(z))
    print(
        json.dumps(
            {
                "status": status,
                "artikel": len(z["artikel"]),
                "bilder": sum(len(a["bilder"]) for a in z["artikel"]),
                "verzeichnis": len(z["verzeichnis"]),
                "sekunden": z["sekunden"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
