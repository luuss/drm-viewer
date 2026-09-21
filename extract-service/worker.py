"""Import-Worker.

Holt Auftraege aus der Warteschlange im Backend, bereitet eine Ausgabe auf und
liefert das Ergebnis in einem Zug ab. Die Warteschlange liegt in der Datenbank:
stuerzt dieser Prozess ab, laeuft die Sperre ab und ein anderer Worker holt den
Auftrag erneut.

Ablauf je Auftrag:
  Quellen laden -> Seiten rendern -> Text lesen -> IDML lesen ->
  Artikel bauen -> Bilder schneiden -> Ergebnis aktivieren
"""

from __future__ import annotations

import os
import socket
import sys
import time
import traceback
from dataclasses import asdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import render
from extractor.article_assembler import assemble, flow_text_blocks
from extractor.idml_extract import (
    extract_idml_blocks,
    extract_idml_image_frames,
    frames_to_images,
)
from extractor.image_regions import read_trim_boxes
from extractor.llm import postprocess_issue
from extractor.model import SourceBlock
from extractor.pdf_extract import extract_pdf_pages, prepare_blocks
from extractor.publication_profiles import apply_profile
from storage import ConvexClient, Storage, issue_key

CONVEX_SITE_URL = os.environ.get("CONVEX_SITE_URL", "").rstrip("/")
SERVICE_SECRET = (
    os.environ.get("EXTRACT_SERVICE_SECRET") or os.environ.get("TILE_SERVICE_SECRET", "")
)
WORKER_ID = os.environ.get("WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}"
POLL_SECONDS = float(os.environ.get("WORKER_POLL_SECONDS", "5"))
IDLE_POLL_MAX_SECONDS = float(os.environ.get("WORKER_IDLE_POLL_MAX_SECONDS", "60"))
MAX_SOURCE_BYTES = int(os.environ.get("MAX_SOURCE_BYTES", 400 * 1024 * 1024))


def log(event: str, **detail) -> None:
    import json

    print(json.dumps({"event": event, "worker": WORKER_ID, **detail}), flush=True)


def idle_poll_delay(empty_polls: int) -> float:
    """Leerlaufabfragen exponentiell ausduennen.

    Eine Abfrage trifft in Convex sowohl die HTTP Action als auch die interne
    Mutation. Ein festes Fuenf-Sekunden-Intervall verbraucht deshalb schon ohne
    einen einzigen Import gut eine Million Funktionsaufrufe pro Monat. Nach
    einem bearbeiteten Auftrag beginnt die Folge wieder bei der kurzen
    Wartezeit; im dauerhaften Leerlauf wird nur noch einmal pro Minute gefragt.
    """
    minimum = max(1.0, POLL_SECONDS)
    maximum = max(minimum, IDLE_POLL_MAX_SECONDS)
    exponent = max(0, min(empty_polls, 20))
    return min(maximum, minimum * (2**exponent))


class Job:
    def __init__(self, convex: ConvexClient, storage: Storage, data: dict) -> None:
        self.convex = convex
        self.storage = storage
        self.data = data
        self.job_id = data["jobId"]
        self.issue_id = data["issueId"]
        self.publication_id = data.get("publicationId") or "unbekannt"
        self.started = time.time()

    def beat(self, progress: int, message: str) -> None:
        res = self.convex.post(
            "/service/jobs/heartbeat",
            {
                "jobId": self.job_id,
                "workerId": WORKER_ID,
                "progress": progress,
                "message": message,
            },
        )
        if not res.get("ok"):
            raise RuntimeError(f"Sperre verloren: {res.get('reason')}")

    def run(self) -> None:
        pages = self.data.get("pages") or []
        sources = self.data.get("sources") or []
        if not pages:
            raise RuntimeError(
                "Keine Seitenreihenfolge festgelegt — bitte im Importdialog bestaetigen"
            )
        if not sources:
            raise RuntimeError("Keine Quelldateien hinterlegt")

        # Quellen einmal laden und im Speicher halten.
        blobs: dict[str, bytes] = {}
        for src in sources:
            if not src.get("url"):
                continue
            if src["kind"] == "indd":
                continue  # Archivdatei, wird nicht ausgewertet
            self.beat(2, f"Lade {src['filename']}")
            blobs[src["assetId"]] = self.convex.download(src["url"], MAX_SOURCE_BYTES)
        log("job.sources", jobId=self.job_id, count=len(blobs))

        page_images = self._render_pages(pages, blobs)
        blocks, images, toc_hints = self._extract(pages, blobs, sources)
        articles = assemble(blocks, images, toc_hints=toc_hints)
        log("job.assembled", jobId=self.job_id, articles=len(articles))

        llm_report = postprocess_issue(
            articles,
            blocks,
            images,
            page_images,
            heartbeat=lambda message: self.beat(86, message),
            event_log=lambda event, **detail: log(
                event, jobId=self.job_id, **detail
            ),
        )
        if llm_report.attempted_chunks:
            log(
                "job.llm",
                jobId=self.job_id,
                attempted=llm_report.attempted_chunks,
                applied=llm_report.applied_chunks,
                fallback=llm_report.failed_chunks,
            )

        payload_articles = self._build_payload(articles, page_images)
        toc_entries = self._build_toc_entries(toc_hints, articles, payload_articles)
        self.beat(92, "Ergebnis wird uebernommen")
        result = self.convex.post(
            "/service/jobs/result",
            {
                "jobId": self.job_id,
                "workerId": WORKER_ID,
                "issueId": self.issue_id,
                "articles": payload_articles,
                **({"tocEntries": toc_entries} if toc_entries else {}),
            },
        )
        log(
            "job.activated",
            jobId=self.job_id,
            articles=result.get("articles"),
            toc=result.get("toc"),
            seconds=round(time.time() - self.started, 1),
        )

    def _render_pages(self, pages: list[dict], blobs: dict[str, bytes]) -> dict[int, bytes]:
        rendered: dict[int, bytes] = {}
        cover_asset_id = None
        total = len(pages)
        for i, page in enumerate(pages):
            blob = blobs.get(page["sourceAssetId"])
            if blob is None:
                continue
            jpeg, width, height = render.render_page(blob, page["sourcePageIndex"])
            key = issue_key(
                self.publication_id, self.issue_id, "pages", page["index"], "full.jpg"
            )
            stored = self.storage.put(key, jpeg, "image/jpeg")
            asset_id = self.convex.post(
                "/service/assets/register",
                {
                    "key": key,
                    "contentType": "image/jpeg",
                    "kind": "page",
                    "issueId": self.issue_id,
                    "storageId": stored.convex_storage_id,
                    "bucket": stored.bucket,
                    "bytes": stored.bytes,
                    "width": width,
                    "height": height,
                },
            )
            self.convex.post(
                "/service/pages/rendered",
                {
                    "issueId": self.issue_id,
                    "index": page["index"],
                    "width": width,
                    "height": height,
                    "previewKey": key,
                },
            )
            rendered[page["index"]] = jpeg
            if page["index"] == 0:
                cover_key = issue_key(
                    self.publication_id, self.issue_id, "covers", "cover.jpg"
                )
                cover = self.storage.put(
                    cover_key, render.make_thumbnail(jpeg), "image/jpeg"
                )
                cover_asset_id = self.convex.post(
                    "/service/assets/register",
                    {
                        "key": cover_key,
                        "contentType": "image/jpeg",
                        "kind": "cover",
                        "issueId": self.issue_id,
                        "storageId": cover.convex_storage_id,
                        "bucket": cover.bucket,
                        "bytes": cover.bytes,
                    },
                )
            if i % 5 == 0:
                self.beat(5 + int(60 * i / max(1, total)), f"Seite {i + 1}/{total}")
        self.convex.post(
            "/service/issue/counts",
            {
                "issueId": self.issue_id,
                "pageCount": total,
                **({"coverAssetId": cover_asset_id} if cover_asset_id else {}),
            },
        )
        log("job.rendered", jobId=self.job_id, pages=len(rendered))
        return rendered

    def _extract(self, pages: list[dict], blobs: dict[str, bytes], sources: list[dict]):
        self.beat(70, "Text wird gelesen")
        by_asset: dict[str, list[tuple[int, int]]] = {}
        for page in pages:
            by_asset.setdefault(page["sourceAssetId"], []).append(
                (page["sourcePageIndex"], page["index"])
            )

        blocks: list[SourceBlock] = []
        images = []
        for asset_id, page_map in by_asset.items():
            blob = blobs.get(asset_id)
            if blob is None:
                continue
            b, i = extract_pdf_pages(blob, page_map)
            blocks.extend(b)
            images.extend(i)

        # IDML liefert die verlaesslicheren Bildrahmen und Artikelgrenzen; das
        # PDF bleibt die Quelle fuer die Seitengeometrie.
        idml_source = next((s for s in sources if s["kind"] == "idml"), None)
        idml_bytes = blobs.get(idml_source["assetId"]) if idml_source else None
        if idml_bytes:
            self.beat(80, "Satzdatei wird ausgewertet")
            images = self._images_from_idml(
                idml_bytes, idml_source, sources, blobs, by_asset, images
            )

        # Publikationskonventionen greifen vor der Klassifikation: Umschlag und
        # gedrucktes Inhaltsverzeichnis sollen weder Artikel noch Bilder liefern.
        blocks, images, toc_hints = apply_profile(
            blocks,
            images,
            pages,
            self.data.get("publicationSlug"),
        )

        # Erst jetzt aufraeumen, damit die Bildunterschriften an den endgueltigen
        # Bildbereichen haengen.
        ordered = prepare_blocks(blocks, images, len(pages))

        if idml_bytes:
            try:
                idml_blocks = extract_idml_blocks(idml_bytes)
                if idml_blocks:
                    ordered = _prefer_idml(ordered, idml_blocks)
                    log("job.idml", jobId=self.job_id, blocks=len(idml_blocks))
            except Exception as exc:
                log("job.idmlFailed", jobId=self.job_id, error=str(exc)[:200])
        return ordered, images, toc_hints

    def _images_from_idml(
        self, idml_bytes, idml_source, sources, blobs, by_asset, images
    ):
        """Bildrahmen aus dem Satz statt aus dem PDF, soweit sie greifen.

        Im Satz steht der Rahmen, der den sichtbaren Ausschnitt bestimmt. Im PDF
        steht nur die Platzierung des Bildes, und was davon zu sehen ist, muss
        ueber Beschnittpfade erschlossen werden. Liegt die Satzdatei vor, ist sie
        also die bessere Quelle.

        Die IDML gehoert zu genau einer PDF-Quelle — der mit derselben Rolle,
        also Innenteil zu Innenteil. Nur deren Seiten werden ersetzt; ein
        Umschlag aus einer zweiten Datei bleibt beim PDF-Weg.
        """
        partner = next(
            (
                s
                for s in sources
                if s["kind"] == "pdf"
                and s.get("role") == idml_source.get("role")
                and blobs.get(s["assetId"])
            ),
            None,
        )
        if partner is None:
            return images
        page_map = by_asset.get(partner["assetId"])
        if not page_map:
            return images
        try:
            frames = extract_idml_image_frames(idml_bytes)
            if not frames:
                return images
            trims = read_trim_boxes(blobs[partner["assetId"]], page_map)
            ersatz = frames_to_images(frames, page_map, trims)
        except Exception as exc:
            log("job.idmlImagesFailed", jobId=self.job_id, error=str(exc)[:200])
            return images
        if not ersatz:
            return images
        betroffen = {canonical for _source, canonical in page_map}
        behalten = [img for img in images if img.page_index not in betroffen]
        log(
            "job.idmlImages",
            jobId=self.job_id,
            frames=len(frames),
            images=len(ersatz),
            replaced=len(images) - len(behalten),
        )
        return behalten + ersatz

    def _build_payload(self, articles, page_images: dict[int, bytes]) -> list[dict]:
        payload = []
        for order, article in enumerate(articles, start=1):
            # `flow_text_blocks` laesst KI-gepruefte Seiten unveraendert und
            # greift nur auf Seiten zurueck, deren LLM-Chunk fehlgeschlagen ist.
            reader_blocks = flow_text_blocks(article.blocks)
            blocks = [
                {
                    "order": i + 1,
                    "type": b.kind if b.kind in
                    ("heading", "subheading", "lead", "paragraph", "quote", "caption", "box")
                    else "other",
                    "text": b.text,
                    "sourcePageIndex": b.page_index,
                    "sourceY": round(max(0.0, min(1.0, b.y0)), 5),
                    **({"sourceStoryId": b.story_id} if b.story_id else {}),
                    **({"styleName": b.style_name} if b.style_name else {}),
                }
                for i, b in enumerate(reader_blocks)
            ]
            regions = [
                {
                    "pageIndex": b.page_index,
                    "x0": round(max(0.0, b.x0), 5),
                    "y0": round(max(0.0, b.y0), 5),
                    "x1": round(min(1.0, b.x1), 5),
                    "y1": round(min(1.0, b.y1), 5),
                    "kind": "title" if b.kind == "heading" else "body",
                }
                for b in article.blocks
            ]
            # Auch das Bild selbst gehoert zur Artikel-Trefferflaeche. Damit
            # bleibt die Zuordnung im Debugger sichtbar und Leser koennen nicht
            # nur auf den danebenliegenden Text klicken.
            regions.extend(
                {
                    "pageIndex": img.page_index,
                    "x0": round(max(0.0, img.x0), 5),
                    "y0": round(max(0.0, img.y0), 5),
                    "x1": round(min(1.0, img.x1), 5),
                    "y1": round(min(1.0, img.y1), 5),
                    "kind": "image",
                }
                for img in article.images
            )
            images = self._store_images(article, page_images, reader_blocks)
            pages = article.pages
            payload.append(
                {
                    "order": order,
                    "title": article.title[:300] or f"Seite {pages[0] + 1}",
                    **({"subtitle": article.subtitle} if article.subtitle else {}),
                    **({"author": article.author} if article.author else {}),
                    **({"teaser": article.teaser} if article.teaser else {}),
                    "source": "hybrid" if article.llm_refined else "pdf",
                    "confidence": article.confidence,
                    "primaryPageIndex": pages[0],
                    "pageStart": pages[0],
                    "pageEnd": pages[-1],
                    "blocks": blocks,
                    "regions": regions,
                    **({"images": images} if images else {}),
                }
            )
        return payload

    def _build_toc_entries(self, hints, articles, payload_articles) -> list[dict]:
        """Gedruckten Inhalt mit Artikeln und Seitensprung-Regionen verbinden."""
        out = []
        for order, hint in enumerate(hints, start=1):
            article_order = next(
                (
                    index + 1
                    for index, article in enumerate(articles)
                    if article.pages and article.pages[0] == hint.page_index
                ),
                None,
            )
            entry = {
                "order": order,
                "label": hint.label,
                "pageIndex": hint.page_index,
                "level": 1,
            }
            if hint.section:
                entry["section"] = hint.section
            if article_order is not None:
                entry["articleOrder"] = article_order
                payload_articles[article_order - 1]["regions"].append(
                    {
                        "pageIndex": hint.toc_page_index,
                        "x0": round(hint.x0, 5),
                        "y0": round(hint.y0, 5),
                        "x1": round(hint.x1, 5),
                        "y1": round(hint.y1, 5),
                        "kind": "other",
                        "targetPageIndex": hint.page_index,
                    }
                )
            out.append(entry)
        return out

    def _store_images(
        self, article, page_images: dict[int, bytes], reader_blocks
    ) -> list[dict]:
        out = []
        for img in article.images:
            page_jpeg = page_images.get(img.page_index)
            if not page_jpeg:
                continue
            try:
                cropped = render.crop_region(page_jpeg, img.x0, img.y0, img.x1, img.y1)
            except Exception:
                continue
            key = issue_key(
                self.publication_id,
                self.issue_id,
                "images",
                f"{img.page_index}-{int(img.x0 * 1000)}-{int(img.y0 * 1000)}.jpg",
            )
            stored = self.storage.put(key, cropped, "image/jpeg")
            asset_id = self.convex.post(
                "/service/assets/register",
                {
                    "key": key,
                    "contentType": "image/jpeg",
                    "kind": "image",
                    "issueId": self.issue_id,
                    "storageId": stored.convex_storage_id,
                    "bucket": stored.bucket,
                    "bytes": stored.bytes,
                },
            )
            entry = {
                "assetId": asset_id,
                "sourcePageIndex": img.page_index,
                "sourceY": round(max(0.0, min(1.0, img.y0)), 5),
            }
            if img.caption:
                entry["caption"] = img.caption
            if img.after_block_order is not None:
                entry["afterBlockOrder"] = img.after_block_order
            elif img.after_block is not None:
                # Erst jetzt ist nach eventuellen Fallback-Merges die endgueltige
                # 1-basierte Reihenfolge der Reader-Bloecke bekannt.
                anchor = next(
                    (
                        index + 1
                        for index, block in enumerate(reader_blocks)
                        if block is img.after_block
                    ),
                    None,
                )
                if anchor is not None:
                    entry["afterBlockOrder"] = anchor
            out.append(entry)
        return out


def _prefer_idml(pdf_blocks: list[SourceBlock], idml_blocks: list[SourceBlock]):
    """IDML-Signale in die PDF-Bloecke uebernehmen.

    Der Text bleibt aus dem PDF, weil dort die Seitengeometrie stimmt. Aus dem
    IDML kommen Story-Zuordnung und Absatzformat: damit weiss der Artikelaufbau,
    welche Bloecke zusammengehoeren, auch ueber Seitengrenzen hinweg.

    Zugeordnet wird ueber den Textanfang; nur eindeutige Treffer zaehlen.
    """
    import re as _re

    def key(text: str) -> str:
        return _re.sub(r"[^a-z0-9]", "", text.lower())[:60]

    index: dict[str, list[SourceBlock]] = {}
    for b in idml_blocks:
        k = key(b.text)
        if len(k) < 20:
            continue
        index.setdefault(k, []).append(b)

    matched = 0
    for b in pdf_blocks:
        candidates = index.get(key(b.text))
        if not candidates or len(candidates) != 1:
            continue
        source = candidates[0]
        b.story_id = source.story_id
        b.style_name = source.style_name
        # Das Absatzformat weiss besser als die Schriftgroesse, was es ist.
        if source.kind in ("heading", "subheading", "lead", "caption"):
            b.kind = source.kind
        matched += 1
    log("idml.matched", blocks=matched)
    return pdf_blocks


def run_once(convex: ConvexClient, storage: Storage) -> bool:
    claimed = convex.post("/service/jobs/claim", {"workerId": WORKER_ID})
    if not claimed:
        return False
    job = Job(convex, storage, claimed)
    log("job.claimed", jobId=job.job_id, issueId=job.issue_id, kind=claimed.get("kind"))
    try:
        job.run()
        convex.post(
            "/service/jobs/finish",
            {
                "jobId": job.job_id,
                "workerId": WORKER_ID,
                "status": "review",
                "message": "Bereit zur redaktionellen Pruefung",
            },
        )
    except Exception as exc:
        traceback.print_exc()
        log("job.failed", jobId=job.job_id, error=str(exc)[:300])
        convex.post(
            "/service/jobs/finish",
            {
                "jobId": job.job_id,
                "workerId": WORKER_ID,
                "status": "error",
                "message": str(exc)[:400],
            },
        )
    return True


def main() -> int:
    if not CONVEX_SITE_URL or not SERVICE_SECRET:
        print("CONVEX_SITE_URL und EXTRACT_SERVICE_SECRET muessen gesetzt sein")
        return 2
    convex = ConvexClient(CONVEX_SITE_URL, SERVICE_SECRET)
    storage = Storage(convex)
    log("worker.start", storage="s3" if storage.uses_s3 else "convex")
    empty_polls = 0
    while True:
        try:
            worked = run_once(convex, storage)
        except Exception as exc:
            log("worker.error", error=str(exc)[:300])
            worked = False
        if worked:
            empty_polls = 0
            continue
        time.sleep(idle_poll_delay(empty_polls))
        empty_polls += 1


if __name__ == "__main__":
    sys.exit(main())
