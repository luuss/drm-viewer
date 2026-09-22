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
    extract_idml_frames,
    frames_to_blocks,
    frames_to_images,
    idml_reading_order,
    link_name,
    toc_from_idml,
)
from extractor.image_regions import read_trim_boxes
from extractor.issue_meta import publication_date, read_cover_meta, read_issue_meta
from extractor.model import SourceBlock
from extractor.pdf_extract import (
    attach_captions,
    extract_pdf_pages,
    mark_furniture,
    prepare_blocks,
)
from extractor.idml_articles import artikel_aus_satz
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

        # Quellen einmal laden und im Speicher halten. Platzierte Bilder
        # bleiben liegen: es sind siebzig und mehr je Heft, und gebraucht wird
        # nur, was am Ende an einem Artikel haengt.
        blobs: dict[str, bytes] = {}
        for src in sources:
            if src["kind"] in ("indd", "artwork"):
                continue
            self.beat(2, f"Lade {src['filename']}")
            data = self._fetch(src)
            if data is None:
                log("job.sourceMissing", jobId=self.job_id, filename=src["filename"])
                continue
            blobs[src["assetId"]] = data
        self._artwork = {
            link_name(src["filename"]): src
            for src in sources
            if src["kind"] == "artwork"
        }
        self._kind_by_asset = {src["assetId"]: src["kind"] for src in sources}
        log(
            "job.sources",
            jobId=self.job_id,
            count=len(blobs),
            artwork=len(self._artwork),
        )

        page_images = self._render_pages(pages, blobs)
        self._store_meta(sources, blobs)
        blocks, images, toc_hints = self._extract(pages, blobs, sources)
        satz = [b for b in blocks if b.origin == "idml"]
        if satz:
            # Der Satz kennt seine Artikel selbst: eine Mengentext-Story ist
            # ein Artikel, die Reihenfolge der Absaetze steht in der Datei.
            # Damit braucht es weder Inhaltsverzeichnis noch Seitenbereiche.
            articles = artikel_aus_satz(satz, images)
            quelle = "satz"
        else:
            articles = assemble(blocks, images, toc_hints=toc_hints)
            quelle = "pdf"
        log(
            "job.assembled",
            jobId=self.job_id,
            articles=len(articles),
            source=quelle,
        )

        payload_articles = self._build_payload(articles, page_images)
        log(
            "job.images",
            jobId=self.job_id,
            fromArtwork=getattr(self, "_artwork_used", 0),
            artworkAvailable=len(getattr(self, "_artwork", {})),
        )
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

    def _fetch(self, src: dict) -> bytes | None:
        """Eine Quelldatei holen.

        Ueber die Convex-Ablage hat das Asset eine kurzlebige Adresse. Laedt der
        Browser dagegen direkt in den Medienspeicher, gibt es keine — dann wird
        die Datei ueber ihren Schluessel aus dem Eimer gelesen.
        """
        url = src.get("url")
        if url:
            return self.convex.download(url, MAX_SOURCE_BYTES)
        key = src.get("assetKey")
        if key and self.storage.uses_s3:
            try:
                return self.storage.get(key)
            except Exception as exc:
                log("job.fetchFailed", jobId=self.job_id, key=key, error=str(exc)[:200])
        return None

    def _store_meta(self, sources: list[dict], blobs: dict[str, bytes]) -> None:
        """Preis und Erscheinungsdatum aus dem Heft nachtragen.

        Der Einzelpreis steht im Impressum des Innenteils, der
        Erscheinungszeitraum in der Kopfzeile der Titelseite. Beides wird nur
        gesetzt, wenn am Heft noch nichts steht; eine Eingabe der Redaktion
        bleibt unangetastet.
        """
        innen = next(
            (
                s
                for s in sources
                if s["kind"] == "pdf" and s.get("role") == "inner" and blobs.get(s["assetId"])
            ),
            None,
        )
        titel = next(
            (s for s in sources if s["kind"] == "image" and blobs.get(s["assetId"])),
            None,
        )
        meta: dict = {}
        if titel is not None:
            meta.update(read_cover_meta(blobs[titel["assetId"]]))
        if innen is not None:
            # Das Impressum ist Text und damit genauer als die Texterkennung
            # auf der Titelseite; es gilt zuletzt.
            meta.update(read_issue_meta(blobs[innen["assetId"]]))
        # Der Preis von der Titelseite bleibt liegen: die Texterkennung
        # verwechselt dort Ziffern (13,60 statt 12,80). Den verlaesslichen
        # Preis liest der Importdialog aus dem Impressum, bevor die Druckdatei
        # ueberhaupt gerendert wird.

        nachricht = {"issueId": self.issue_id}
        if meta.get("priceAmountCents"):
            nachricht["priceAmountCents"] = meta["priceAmountCents"]
        datum = publication_date(meta)
        if datum:
            nachricht["publicationDate"] = datum
        if len(nachricht) > 1:
            self.convex.post("/service/issue/counts", nachricht)
        log("job.meta", jobId=self.job_id, **{k: v for k, v in meta.items()})

    def _page_image(self, page: dict) -> bytes | None:
        """Eine bereits gerenderte Seite holen.

        Ueber den Medienspeicher geht es ueber den Schluessel, ueber die
        Convex-Ablage ueber die mitgelieferte Adresse.
        """
        schluessel = page.get("previewKey")
        if not schluessel:
            return None
        cache = getattr(self, "_page_cache", None)
        if cache is None:
            cache = self._page_cache = {}
        if schluessel in cache:
            return cache[schluessel]
        daten = None
        if self.storage.uses_s3:
            try:
                daten = self.storage.get(schluessel)
            except Exception as exc:
                log(
                    "job.pageMissing",
                    jobId=self.job_id,
                    key=schluessel,
                    error=str(exc)[:160],
                )
        if daten is None and page.get("previewUrl"):
            daten = self.convex.download(page["previewUrl"], MAX_SOURCE_BYTES)
        cache[schluessel] = daten
        return daten

    def _store_cover(self, seite_jpeg: bytes) -> str | None:
        """Titelbild des Hefts aus der ersten Seite."""
        cover_key = issue_key(self.publication_id, self.issue_id, "covers", "cover.jpg")
        cover = self.storage.put(
            cover_key, render.make_thumbnail(seite_jpeg), "image/jpeg"
        )
        return self.convex.post(
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

    def _render_pages(self, pages: list[dict], blobs: dict[str, bytes]) -> dict[int, bytes]:
        rendered: dict[int, bytes] = {}
        cover_asset_id = None
        total = len(pages)
        for i, page in enumerate(pages):
            if page.get("previewKey"):
                # Die Seite liegt schon als Bild vor: der Browser hat sie beim
                # Import gerendert. Dann gibt es hier nichts herzustellen, nur
                # zu holen — fuer die Ausschnitte der Artikelbilder.
                fertig = self._page_image(page)
                if fertig is not None:
                    rendered[page["index"]] = fertig
                    if page["index"] == 0:
                        cover_asset_id = self._store_cover(fertig)
                if i % 10 == 0:
                    self.beat(5 + int(60 * i / max(1, total)), f"Seite {i + 1}/{total}")
                continue

            blob = blobs.get(page["sourceAssetId"])
            if blob is None:
                continue
            if getattr(self, "_kind_by_asset", {}).get(page["sourceAssetId"]) == "image":
                # Titelseite als Bild statt als PDF.
                jpeg, width, height = render.render_image_page(blob)
            else:
                jpeg, width, height = render.render_page(
                    blob, page["sourcePageIndex"], half=page.get("sourceHalf") or None
                )
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
                cover_asset_id = self._store_cover(jpeg)
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
        by_asset: dict[str, list[tuple[int, int]]] = {}
        # Umschlag-Doppelseiten: je kanonischer Seite die Haelfte der Quellseite.
        halves_by_asset: dict[str, dict[int, str]] = {}
        for page in pages:
            by_asset.setdefault(page["sourceAssetId"], []).append(
                (page["sourcePageIndex"], page["index"])
            )
            if page.get("sourceHalf"):
                halves_by_asset.setdefault(page["sourceAssetId"], {})[page["index"]] = (
                    page["sourceHalf"]
                )
        self._halves_by_asset = halves_by_asset

        idml_source = next((s for s in sources if s["kind"] == "idml"), None)
        idml_bytes = blobs.get(idml_source["assetId"]) if idml_source else None

        blocks: list[SourceBlock] = []
        images = []
        # Seiten, die der Satz selbst beschreibt. Fuer sie wird die PDF-Textebene
        # nicht mehr gebraucht.
        aus_satz: set[int] = set()

        if idml_bytes:
            self.beat(72, "Satzdatei wird ausgewertet")
            # Der Satz beschreibt den Innenteil. Das sind die Inhaltsseiten, in
            # der Reihenfolge, in der sie aus ihrer Quelle kommen.
            page_map = sorted(
                (p["sourcePageIndex"], p["index"])
                for p in pages
                if p.get("role") == "content"
            )
            partner = self._idml_partner(idml_source, sources, blobs)
            try:
                satz_blocks, satz_images = self._from_idml(
                    idml_bytes,
                    blobs.get(partner["assetId"]) if partner else None,
                    page_map,
                    halves_by_asset.get(partner["assetId"]) if partner else None,
                )
            except Exception as exc:
                log("job.idmlFailed", jobId=self.job_id, error=str(exc)[:200])
                satz_blocks, satz_images = [], []
            if satz_blocks:
                blocks.extend(satz_blocks)
                aus_satz = {kanonisch for _quelle, kanonisch in page_map}
            images.extend(satz_images)
            log(
                "job.idml",
                jobId=self.job_id,
                blocks=len(satz_blocks),
                images=len(satz_images),
                pages=len(aus_satz),
                trimFrom="pdf" if partner else "netzformat",
            )

        # Was der Satz nicht abdeckt — ein Umschlag aus einer zweiten Datei,
        # oder ein Heft ganz ohne Satzdatei — kommt weiter aus dem PDF.
        self.beat(76, "Text wird gelesen")
        for asset_id, page_map in by_asset.items():
            blob = blobs.get(asset_id)
            if blob is None:
                continue
            if getattr(self, "_kind_by_asset", {}).get(asset_id) == "image":
                # Eine Titelseite als Bild hat weder Textebene noch Rahmen.
                continue
            rest = [(q, k) for q, k in page_map if k not in aus_satz]
            if not rest:
                continue
            b, i = extract_pdf_pages(blob, rest, halves_by_asset.get(asset_id))
            blocks.extend(b)
            images.extend(i)

        # Steht das Inhaltsverzeichnis im Satz, ist es dort eindeutig
        # ausgezeichnet. Das schlaegt jede Erkennung ueber Schriftgroessen —
        # gelesen wird es, bevor das Profil die Inhaltsseite aussortiert.
        satz_toc = (
            toc_from_idml(
                [b for b in blocks if b.origin == "idml"], _printed_offset(pages)
            )
            if aus_satz
            else []
        )

        # Publikationskonventionen greifen vor der Klassifikation: Umschlag und
        # gedrucktes Inhaltsverzeichnis sollen weder Artikel noch Bilder liefern.
        blocks, images, toc_hints = apply_profile(
            blocks,
            images,
            pages,
            self.data.get("publicationSlug"),
        )
        if satz_toc:
            log("job.toc", jobId=self.job_id, entries=len(satz_toc), source="idml")
            toc_hints = satz_toc

        # Beide Herkuenfte werden getrennt aufbereitet: die PDF-Bloecke brauchen
        # Schriftgroessen und Spaltenerkennung, die Satz-Bloecke bringen ihre
        # Rollen schon mit und wuerden davon nur verfaelscht.
        aus_pdf = [b for b in blocks if b.origin != "idml"]
        satz = [b for b in blocks if b.origin == "idml"]
        geordnet: list[SourceBlock] = []
        if aus_pdf:
            geordnet.extend(prepare_blocks(aus_pdf, images, len(pages)))
        if satz:
            geordnet.extend(self._prepare_satz(satz, images, len(pages)))
        # Stabil nach Seite: innerhalb einer Seite bleibt die eben hergestellte
        # Reihenfolge erhalten.
        ordered = sorted(geordnet, key=lambda b: b.page_index)
        return ordered, images, toc_hints

    @staticmethod
    def _prepare_satz(
        blocks: list[SourceBlock], images, page_count: int
    ) -> list[SourceBlock]:
        """Satz-Bloecke aufraeumen und ordnen.

        Kolumnentitel und Seitenzahlen sind auch im Satz eigene Rahmen; sie
        werden wie beim PDF an ihrer Wiederholung erkannt. Eine Klassifikation
        nach Schriftgroesse entfaellt — das Absatzformat hat sie schon gesagt.
        """
        mark_furniture(blocks, page_count)
        ordered = idml_reading_order([b for b in blocks if not b.drop])
        attach_captions(images, ordered)
        return ordered

    def _from_idml(self, idml_bytes, pdf_bytes, page_map, halves):
        """Bloecke und Bildbereiche aus der Satzdatei.

        Der Satz kennt nur das Netzformat. Liegt das Druck-PDF vor, wird daraus
        die Trimbox gelesen und der Anschnitt mitgerechnet. Hat dagegen schon
        der Browser die Seiten auf das Netzformat geschnitten, decken sich beide
        Systeme und es gibt nichts umzurechnen.
        """
        bildrahmen, textrahmen = extract_idml_frames(idml_bytes)
        trims = read_trim_boxes(pdf_bytes, page_map, halves) if pdf_bytes else {}
        satz_blocks = frames_to_blocks(
            extract_idml_blocks(idml_bytes, textrahmen), page_map, trims
        )
        satz_images = frames_to_images(bildrahmen, page_map, trims)
        return satz_blocks, satz_images

    @staticmethod
    def _idml_partner(idml_source, sources, blobs):
        """Die PDF-Quelle, zu der die Satzdatei gehoert.

        Traegt die IDML eine eigene Rolle, gilt die gleichnamige PDF; die
        Oberflaeche legt sie aber als Beiwerk ab, und dann ist der Innenteil
        gemeint.
        """
        gesuchte_rolle = idml_source.get("role")
        if gesuchte_rolle in (None, "supplemental", "artwork", "archive"):
            gesuchte_rolle = "inner"
        return next(
            (
                s
                for s in sources
                if s["kind"] == "pdf"
                and s.get("role") == gesuchte_rolle
                and blobs.get(s["assetId"])
            ),
            None,
        )

    def _build_payload(self, articles, page_images: dict[int, bytes]) -> list[dict]:
        payload = []
        for order, article in enumerate(articles, start=1):
            reader_blocks = flow_text_blocks(article.blocks)
            # Unterzeile und Vorspann stehen schon im Kopf des Artikels. Als
            # Block noch einmal gedruckt, liest sich das wie ein Versehen.
            kopfzeilen = {
                t.strip()
                for t in (article.subtitle, article.teaser, article.title)
                if t
            }
            reader_blocks = [
                b
                for b in reader_blocks
                if not (b.kind in ("lead", "heading") and b.text.strip() in kopfzeilen)
            ]
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
            regions = _text_regions(article.blocks)
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
                    "source": article.source,
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
            # Ein Eintrag ohne Stelle im gedruckten Verzeichnis (etwa ein
            # Editorial aus der Heftkonvention) bekommt keine Klickflaeche.
            if article_order is not None and hint.toc_page_index is not None:
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

    # Bildrahmen und platziertes Bild duerfen sich im Seitenverhaeltnis um
    # diesen Anteil unterscheiden und gelten noch als deckungsgleich.
    ARTWORK_TOLERANZ = 0.08

    def _artwork_image(self, img, page_jpeg: bytes) -> bytes | None:
        """Das platzierte Originalbild statt des Seitenausschnitts, wenn es passt.

        Die Satzdatei nennt zu jedem Bildrahmen die Datei aus `Links/`. Der
        Browser hat sie beim Import auf Netzgroesse gebracht und hochgeladen.
        Genommen wird sie aber nur, wenn der Rahmen das ganze Bild zeigt: hat
        der Satz beschnitten, stuende im Artikel sonst mehr, als gedruckt ist.
        Das Seitenverhaeltnis verraet den Unterschied.
        """
        name = getattr(img, "link", None)
        src = getattr(self, "_artwork", {}).get(link_name(name)) if name else None
        if src is None:
            return None
        try:
            seite = render.image_size(page_jpeg)
            rahmen_breite = (img.x1 - img.x0) * seite[0]
            rahmen_hoehe = (img.y1 - img.y0) * seite[1]
            if rahmen_breite < 8 or rahmen_hoehe < 8:
                return None
            data = self._artwork_blob(src)
            if data is None:
                return None
            bild = render.image_size(data)
            if bild[0] < 8 or bild[1] < 8:
                return None
            ausschnitt = getattr(img, "crop", None)
            if ausschnitt is not None:
                # Der Satz sagt genau, welcher Teil der Datei im Rahmen steht.
                # Dann muss nichts geschaetzt werden.
                u0, v0, u1, v1 = ausschnitt
                # Ohne Weissrandschnitt: der Satz hat den Rand so gewollt.
                return render.fit_image(
                    render.crop_region(data, u0, v0, u1, v1, trim_blank=False)
                )
            rahmen_verhaeltnis = rahmen_breite / rahmen_hoehe
            bild_verhaeltnis = bild[0] / bild[1]
            abweichung = abs(rahmen_verhaeltnis - bild_verhaeltnis) / max(
                rahmen_verhaeltnis, bild_verhaeltnis
            )
            if abweichung > self.ARTWORK_TOLERANZ:
                return None
            return render.fit_image(data)
        except Exception as exc:
            log("job.artworkFailed", jobId=self.job_id, name=name, error=str(exc)[:200])
            return None

    def _artwork_blob(self, src: dict) -> bytes | None:
        """Ein platziertes Bild holen und im Speicher behalten."""
        cache = getattr(self, "_artwork_cache", None)
        if cache is None:
            cache = self._artwork_cache = {}
        key = src["assetId"]
        if key not in cache:
            cache[key] = self._fetch(src)
        return cache[key]

    def _store_images(
        self, article, page_images: dict[int, bytes], reader_blocks
    ) -> list[dict]:
        out = []
        for img in article.images:
            page_jpeg = page_images.get(img.page_index)
            if not page_jpeg:
                continue
            cropped = self._artwork_image(img, page_jpeg)
            if cropped is not None:
                self._artwork_used = getattr(self, "_artwork_used", 0) + 1
            if cropped is None:
                try:
                    cropped = render.crop_region(
                        page_jpeg, img.x0, img.y0, img.x1, img.y1
                    )
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


def _text_regions(blocks) -> list[dict]:
    """Trefferflaechen des Artikels im Seitenmodus.

    Liegt der Satz vor, ist der Textrahmen die richtige Flaeche: er steht fest,
    waehrend die Stelle eines einzelnen Absatzes darin nur geschaetzt ist. Ein
    Rahmen wird einmal genommen, auch wenn zwanzig Absaetze darin stehen —
    sonst liegen zwanzig Rechtecke uebereinander.

    Ohne Satz bleibt es beim Block: aus dem PDF ist das alles, was es gibt.
    """
    out: list[dict] = []
    gesehen: set[tuple] = set()
    for b in blocks:
        kasten = getattr(b, "frame_box", None)
        if kasten is not None:
            kennung = (b.page_index, b.frame_id or kasten)
            if kennung in gesehen:
                continue
            gesehen.add(kennung)
            x0, y0, x1, y1 = kasten
            art = "body"
        else:
            x0, y0, x1, y1 = b.x0, b.y0, b.x1, b.y1
            art = "title" if b.kind == "heading" else "body"
        out.append(
            {
                "pageIndex": b.page_index,
                "x0": round(max(0.0, min(x0, x1)), 5),
                "y0": round(max(0.0, min(y0, y1)), 5),
                "x1": round(min(1.0, max(x0, x1)), 5),
                "y1": round(min(1.0, max(y0, y1)), 5),
                "kind": art,
            }
        )
    return out


def _printed_offset(pages: list[dict]) -> int:
    """Differenz zwischen gedruckter Seitenzahl und kanonischem Index.

    Steht auf der ersten Innenseite eine 3 und liegt sie an Position 1, ist der
    Versatz 2. Ohne brauchbare Angabe gilt 0 — dann sind gedruckte Zahl und
    Position dasselbe.
    """
    for page in pages:
        label = (page.get("printedLabel") or "").strip()
        if label.isdigit():
            return int(label) - page["index"]
    return 0


if __name__ == "__main__":
    sys.exit(main())
