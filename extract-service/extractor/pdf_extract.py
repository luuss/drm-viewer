"""PDF eines Druckhefts in Artikel zerlegen.

Der Weg ist bewusst regelbasiert und ohne Texterkennung: Satzdateien aus
InDesign bringen eine saubere Textebene mit. Aus Schriftgroessen, Position und
Lesereihenfolge entsteht die Artikelgrenze. Eine optionale LLM-Stufe korrigiert
danach nur noch die Gruppierung, nicht den Text.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any

import pymupdf

from . import llm
from .textutil import clean_text, first_sentence, is_probably_heading, normalize_compare


@dataclass
class Block:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    size: float
    max_size: float
    bold: bool
    char_count: int
    spans: list[dict] = field(default_factory=list)
    kind: str = "body"  # body | heading | subheading | caption | furniture
    column: int = 0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass
class ImageRef:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    data: bytes
    ext: str
    width: int
    height: int
    caption: str | None = None

    @property
    def area(self) -> float:
        return (self.x1 - self.x0) * (self.y1 - self.y0)


@dataclass
class Article:
    title: str
    text: str
    page_start: int
    page_end: int
    boxes: list[dict] = field(default_factory=list)
    subtitle: str | None = None
    author: str | None = None
    teaser: str | None = None
    images: list[ImageRef] = field(default_factory=list)

    def to_dict(self, order: int) -> dict[str, Any]:
        return {
            "order": order,
            "title": self.title[:300],
            "subtitle": self.subtitle,
            "author": self.author,
            "teaser": self.teaser,
            "text": self.text,
            "pageStart": self.page_start,
            "pageEnd": self.page_end,
            "boxes": self.boxes,
            "source": "pdf",
            # Rohdaten der Bilder; der Dienst legt sie ab und ersetzt sie
            # durch Speicher-Verweise, bevor das Ergebnis zurueckgeht.
            "_images": [
                {
                    "page": img.page + 1,
                    "caption": img.caption,
                    "data": img.data,
                    "ext": img.ext,
                }
                for img in self.images
            ],
        }


MIN_IMAGE_PIXELS = 200
MIN_IMAGE_BYTES = 8 * 1024
# Druckaufloesung ist fuers Netz Verschwendung: kostet Speicher und Leitung.
MAX_WEB_PIXELS = 1600
WEB_JPEG_QUALITY = 82


def _to_web_image(data: bytes, ext: str) -> tuple[bytes, str]:
    """Bild auf Bildschirmgroesse bringen. Bei Fehlern bleibt das Original."""
    try:
        pix = pymupdf.Pixmap(data)
        if pix.alpha:
            pix = pymupdf.Pixmap(pix, 0)
        if pix.colorspace and pix.colorspace.n > 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        # shrink halbiert je Schritt; das reicht und ist verlustarm genug.
        while max(pix.width, pix.height) > MAX_WEB_PIXELS * 2:
            pix.shrink(1)
        out = pix.tobytes("jpeg", jpg_quality=WEB_JPEG_QUALITY)
        if len(out) < len(data):
            return out, "jpeg"
        return data, ext
    except Exception:
        return data, ext


def _collect_images(doc: pymupdf.Document) -> list[ImageRef]:
    """Bilder mit Position einsammeln. Logos und Trennlinien fliegen raus."""
    out: list[ImageRef] = []
    for pno in range(doc.page_count):
        page = doc[pno]
        for b in page.get_text("dict")["blocks"]:
            if b.get("type") != 1:
                continue
            data = b.get("image")
            if not data or len(data) < MIN_IMAGE_BYTES:
                continue
            w, h = int(b.get("width", 0)), int(b.get("height", 0))
            if w < MIN_IMAGE_PIXELS or h < MIN_IMAGE_PIXELS:
                continue
            web_data, web_ext = _to_web_image(data, (b.get("ext") or "png").lower())
            out.append(
                ImageRef(
                    page=pno,
                    x0=b["bbox"][0],
                    y0=b["bbox"][1],
                    x1=b["bbox"][2],
                    y1=b["bbox"][3],
                    data=web_data,
                    ext=web_ext,
                    width=w,
                    height=h,
                )
            )
    return out


def _collect_blocks(doc: pymupdf.Document) -> tuple[list[Block], dict[int, tuple[float, float]]]:
    blocks: list[Block] = []
    page_sizes: dict[int, tuple[float, float]] = {}
    for pno in range(doc.page_count):
        page = doc[pno]
        page_sizes[pno] = (page.rect.width, page.rect.height)
        data = page.get_text("dict")
        for b in data["blocks"]:
            if b.get("type") != 0:
                continue
            spans = [s for line in b["lines"] for s in line["spans"]]
            if not spans:
                continue
            raw_spans = [
                {
                    "text": s["text"],
                    "size": s["size"],
                    "bbox": s["bbox"],
                    "font": s["font"],
                }
                for line in b["lines"]
                for s in line["spans"]
            ]
            text = ""
            for line in b["lines"]:
                line_text = "".join(s["text"] for s in line["spans"])
                text += line_text + "\n"
            text = clean_text(text)
            if not text:
                continue
            sizes = [s["size"] for s in spans for _ in s["text"]] or [
                s["size"] for s in spans
            ]
            bold = sum(
                len(s["text"]) for s in spans if "bold" in s["font"].lower()
            ) > 0.6 * max(1, sum(len(s["text"]) for s in spans))
            blocks.append(
                Block(
                    page=pno,
                    x0=b["bbox"][0],
                    y0=b["bbox"][1],
                    x1=b["bbox"][2],
                    y1=b["bbox"][3],
                    text=text,
                    size=statistics.median(sizes),
                    max_size=max(sizes),
                    bold=bold,
                    char_count=len(text),
                    spans=raw_spans,
                )
            )
    return blocks, page_sizes


def _body_size(blocks: list[Block]) -> float:
    counter: Counter[float] = Counter()
    for b in blocks:
        counter[round(b.size, 1)] += b.char_count
    if not counter:
        return 10.0
    return counter.most_common(1)[0][0]


def _body_font(blocks: list[Block], body: float) -> str:
    counter: Counter[str] = Counter()
    for b in blocks:
        if abs(b.size - body) > 0.6:
            continue
        for sp in b.spans:
            counter[sp["font"]] += len(sp["text"])
    return counter.most_common(1)[0][0] if counter else ""


def _mark_furniture(blocks: list[Block], page_count: int) -> None:
    """Kolumnentitel und Seitenzahlen erkennen: gleicher Text, gleiche Hoehe, viele Seiten."""
    buckets: dict[tuple[str, int], list[Block]] = defaultdict(list)
    for b in blocks:
        if b.char_count > 120:
            continue
        key = (
            re.sub(r"\d+", "", normalize_compare(b.text))[:40],
            int(b.y0 // 20),
        )
        if not key[0]:
            continue
        buckets[key].append(b)
    threshold = max(3, page_count * 0.25)
    for group in buckets.values():
        pages = {b.page for b in group}
        if len(pages) >= threshold:
            for b in group:
                b.kind = "furniture"
    for b in blocks:
        stripped = b.text.strip()
        # Seitenzahlen, Setzer-Slug ("datei.indd 9 11.02.26"), Einzelbuchstaben.
        if stripped.isdigit() and len(stripped) <= 3:
            b.kind = "furniture"
        elif ".indd" in stripped.lower():
            b.kind = "furniture"
        elif len(stripped) <= 2:
            b.kind = "furniture"


def _split_inline_drop_caps(blocks: list[Block], body: float) -> list[Block]:
    """Initialen sitzen im Satz oft im selben Block wie die Ueberschrift.

    Beispiel aus dem Testheft: ein Block enthaelt "Erneute Forderungen nach
    Gold-Rueckholung" in 28pt und zusaetzlich das grosse "D" der Initiale.
    Ohne Trennung klebt der Buchstabe an der Ueberschrift und fehlt im Text.
    """
    extra: list[Block] = []
    for b in blocks:
        if not b.spans or len(b.spans) < 2:
            continue
        caps = [
            s
            for s in b.spans
            if s["size"] >= body * 1.7
            and len(s["text"].strip()) <= 2
            and s["text"].strip().isalpha()
        ]
        if not caps:
            continue
        rest = [s for s in b.spans if s not in caps]
        rest_chars = sum(len(s["text"].strip()) for s in rest)
        if rest_chars < 3:
            continue
        b.text = clean_text("".join(s["text"] for s in rest))
        b.char_count = len(b.text)
        b.spans = rest
        if rest:
            sizes = [s["size"] for s in rest]
            b.size = statistics.median(sizes)
            b.max_size = max(sizes)
        for c in caps:
            extra.append(
                Block(
                    page=b.page,
                    x0=c["bbox"][0],
                    y0=c["bbox"][1],
                    x1=c["bbox"][2],
                    y1=c["bbox"][3],
                    text=c["text"].strip(),
                    size=c["size"],
                    max_size=c["size"],
                    bold=False,
                    char_count=len(c["text"].strip()),
                    spans=[c],
                )
            )
    return blocks + extra


def _merge_drop_caps(blocks: list[Block], body: float) -> list[Block]:
    """Initialen stehen als eigener Block und gehoeren an den Textanfang.

    Sicheres Merkmal: der Anschlusstext beginnt klein ("eutsche Politiker ...").
    Ohne diese Pruefung landet die Initiale sonst in der Ueberschrift daneben.
    """
    used: set[int] = set()
    by_page: dict[int, list[int]] = defaultdict(list)
    for i, b in enumerate(blocks):
        by_page[b.page].append(i)

    for i, b in enumerate(blocks):
        if i in used:
            continue
        stripped = b.text.strip()
        if len(stripped) > 2 or not stripped.isalpha():
            continue
        if b.max_size < body * 1.8:
            continue
        best = None
        best_dist = 1e9
        for j in by_page[b.page]:
            if j == i:
                continue
            c = blocks[j]
            if c.max_size > body * 1.25 or c.char_count < 40:
                continue
            head = c.text.lstrip()[:1]
            if not head or not head.islower():
                continue
            if c.y0 > b.y1 + 4 or c.y1 < b.y0 - 4:
                continue
            if c.x0 < b.x0 - 4 or c.x0 > b.x1 + 40:
                continue
            dist = abs(c.y0 - b.y0) + abs(c.x0 - b.x0)
            if dist < best_dist:
                best, best_dist = j, dist
        if best is not None:
            c = blocks[best]
            c.text = stripped + c.text
            c.x0 = min(c.x0, b.x0)
            c.y0 = min(c.y0, b.y0)
            used.add(i)

    return [b for k, b in enumerate(blocks) if k not in used]


def _merge_heading_runs(blocks: list[Block], body: float) -> list[Block]:
    """Mehrzeilige Ueberschriften liefert der Satz als mehrere Bloecke."""
    out: list[Block] = []
    for b in blocks:
        if out:
            prev = out[-1]
            overlap = min(prev.x1, b.x1) - max(prev.x0, b.x0)
            span = max(prev.x1 - prev.x0, b.x1 - b.x0, 1.0)
            same_line_family = (
                prev.kind == b.kind == "heading"
                and prev.page == b.page
                and abs(prev.max_size - b.max_size) < 1.2
                and overlap > span * 0.45
                and -2 <= b.y0 - prev.y1 < prev.max_size * 1.6
            )
            if same_line_family:
                prev.text = (prev.text + " " + b.text).strip()
                prev.x1 = max(prev.x1, b.x1)
                prev.y1 = max(prev.y1, b.y1)
                prev.char_count = len(prev.text)
                continue
        out.append(b)
    return out


def _columns(page_blocks: list[Block], page_width: float) -> None:
    """Spalten ueber die x-Mitten gruppieren; Ueberschriften ueber mehrere Spalten bleiben breit."""
    centers = sorted((b.x0 + b.x1) / 2 for b in page_blocks)
    if not centers:
        return
    gaps: list[tuple[float, float]] = []
    for a, b in zip(centers, centers[1:]):
        gaps.append((b - a, (a + b) / 2))
    splits = [pos for gap, pos in gaps if gap > page_width * 0.12]
    splits.sort()
    for b in page_blocks:
        c = (b.x0 + b.x1) / 2
        idx = 0
        for s in splits:
            if c > s:
                idx += 1
        b.column = idx


def _reading_order(page_blocks: list[Block], page_width: float) -> list[Block]:
    """Breite Elemente (Titel, Bildunterschrift ueber alles) vor den Spalten lesen."""
    wide = [b for b in page_blocks if b.width > page_width * 0.62]
    rest = [b for b in page_blocks if b not in wide]
    _columns(rest, page_width)
    rest.sort(key=lambda b: (b.column, b.y0))
    wide.sort(key=lambda b: b.y0)

    out: list[Block] = []
    for w in wide:
        out.append(w)
    # Spaltentext nach den breiten Elementen, aber in Spaltenreihenfolge.
    out.extend(rest)
    out.sort(key=lambda b: (0 if b in wide else 1, b.y0 if b in wide else 0, b.column, b.y0))
    return out


def _classify(blocks: list[Block], body: float, body_font: str) -> None:
    for b in blocks:
        if b.kind == "furniture":
            continue
        fonts = {sp["font"] for sp in b.spans}
        foreign_font = bool(body_font) and body_font not in fonts

        if b.text.strip().lower().startswith(("foto:", "fotos:", "bild:", "grafik:")):
            b.kind = "caption"
        elif b.max_size <= body * 0.9:
            b.kind = "caption"
        elif foreign_font and b.max_size <= body * 1.12 and b.char_count <= 400:
            # Schmuckzitat oder Bildunterschrift im Hausfont — nicht Fliesstext.
            b.kind = "caption"
        elif b.max_size >= body * 1.45 and is_probably_heading(b.text):
            b.kind = "heading"
        elif (
            b.max_size >= body * 1.12
            and b.char_count <= 220
            and is_probably_heading(b.text)
        ):
            b.kind = "subheading"


def _attach_captions(images: list[ImageRef], blocks: list[Block]) -> None:
    """Die Unterschrift steht unter dem Bild und ueberlappt es waagerecht."""
    captions = [b for b in blocks if b.kind == "caption"]
    for img in images:
        best = None
        best_gap = 1e9
        for c in captions:
            if c.page != img.page:
                continue
            gap = c.y0 - img.y1
            if gap < -6 or gap > 90:
                continue
            overlap = min(c.x1, img.x1) - max(c.x0, img.x0)
            if overlap < (img.x1 - img.x0) * 0.35:
                continue
            if gap < best_gap:
                best, best_gap = c, gap
        if best is not None:
            text = best.text.strip()
            # Reine Bildnachweise sind als Unterschrift wertlos.
            if not text.lower().startswith(("foto:", "fotos:", "bild:", "grafik:")):
                img.caption = text[:400]


def _assign_images(
    articles: list[Article],
    images: list[ImageRef],
    page_sizes: dict[int, tuple[float, float]],
) -> None:
    """Jedes Bild bekommt den Artikel, dessen Textflaeche auf der Seite am naechsten liegt."""
    for img in images:
        w, h = page_sizes.get(img.page, (1.0, 1.0))
        ix = ((img.x0 + img.x1) / 2) / max(w, 1.0)
        iy = ((img.y0 + img.y1) / 2) / max(h, 1.0)
        best: Article | None = None
        best_dist = 1e9
        for a in articles:
            for box in a.boxes:
                if box["page"] != img.page + 1:
                    continue
                bx = (box["x0"] + box["x1"]) / 2
                by = (box["y0"] + box["y1"]) / 2
                dist = abs(bx - ix) + abs(by - iy)
                if dist < best_dist:
                    best, best_dist = a, dist
        if best is None:
            # Kein Text auf der Seite: dem Artikel geben, der die Seite umfasst.
            for a in articles:
                if a.page_start <= img.page + 1 <= a.page_end:
                    best = a
                    break
        if best is not None and len(best.images) < 12:
            best.images.append(img)


def _norm_box(b: Block, w: float, h: float) -> dict:
    return {
        "page": b.page + 1,
        "x0": round(max(0.0, b.x0 / w), 5),
        "y0": round(max(0.0, b.y0 / h), 5),
        "x1": round(min(1.0, b.x1 / w), 5),
        "y1": round(min(1.0, b.y1 / h), 5),
    }


def group_articles(
    blocks: list[Block],
    page_sizes: dict[int, tuple[float, float]],
    min_chars: int = 320,
) -> list[Article]:
    articles: list[Article] = []
    current: Article | None = None
    pending_sub: list[str] = []

    for b in blocks:
        if b.kind in ("furniture", "caption"):
            continue
        w, h = page_sizes[b.page]

        if b.kind == "heading":
            if current and len(current.text) < min_chars and current.title:
                # Zu kurzer Vorgaenger: vermutlich Dachzeile des neuen Artikels.
                pending_sub.append(current.title)
                articles.pop() if articles and articles[-1] is current else None
            current = Article(
                title=b.text.strip().replace("\n", " "),
                text="",
                page_start=b.page + 1,
                page_end=b.page + 1,
                boxes=[_norm_box(b, w, h)],
                subtitle=" — ".join(pending_sub) if pending_sub else None,
            )
            pending_sub = []
            articles.append(current)
            continue

        if current is None:
            current = Article(
                title=(b.text.strip().split("\n")[0][:120] or f"Seite {b.page + 1}"),
                text="",
                page_start=b.page + 1,
                page_end=b.page + 1,
                boxes=[],
            )
            articles.append(current)

        if b.kind == "subheading" and not current.text:
            current.subtitle = (
                f"{current.subtitle} — {b.text}" if current.subtitle else b.text
            )
        else:
            current.text = (current.text + "\n\n" + b.text).strip()
        current.boxes.append(_norm_box(b, w, h))
        current.page_end = max(current.page_end, b.page + 1)

    # Zu kurze Fragmente an den Vorgaenger haengen — meist Bildunterschriften.
    merged: list[Article] = []
    for a in articles:
        a.text = clean_text(a.text)
        if merged and len(a.text) < min_chars and not a.title.strip():
            prev = merged[-1]
            prev.text = (prev.text + "\n\n" + a.text).strip()
            prev.boxes.extend(a.boxes)
            prev.page_end = max(prev.page_end, a.page_end)
            continue
        merged.append(a)

    for a in merged:
        if a.text:
            a.teaser = first_sentence(a.text)
    return [a for a in merged if a.text or a.title]


def _articles_from_llm_groups(
    groups: list[dict],
    ordered: list[Block],
    page_sizes: dict[int, tuple[float, float]],
) -> list[Article]:
    by_id = {i: b for i, b in enumerate(ordered)}
    articles: list[Article] = []
    for g in groups:
        ids = [i for i in g.get("blockIds", []) if i in by_id]
        blocks = [by_id[i] for i in ids if by_id[i].kind not in ("furniture", "caption")]
        if not blocks:
            continue
        body_blocks = [b for b in blocks if b.kind == "body"]
        text = clean_text("\n\n".join(b.text for b in body_blocks))
        pages = [b.page + 1 for b in blocks]
        boxes = []
        for b in blocks:
            w, h = page_sizes[b.page]
            boxes.append(_norm_box(b, w, h))
        title = (g.get("title") or "").strip()
        if not title:
            head = next((b for b in blocks if b.kind == "heading"), None)
            title = head.text.strip() if head else f"Seite {min(pages)}"
        articles.append(
            Article(
                title=title,
                text=text,
                page_start=min(pages),
                page_end=max(pages),
                boxes=boxes,
                subtitle=(g.get("subtitle") or None),
                teaser=first_sentence(text) if text else None,
            )
        )
    return articles


def _digest_blocks(ordered: list[Block]) -> list[dict]:
    return [
        {
            "id": i,
            "page": b.page + 1,
            "x0": b.x0,
            "y0": b.y0,
            "size": b.max_size,
            "kind": b.kind,
            "chars": b.char_count,
            "start": b.text[:120],
        }
        for i, b in enumerate(ordered)
    ]


def extract_pdf(
    path: str,
    min_chars: int = 320,
    use_llm: bool = True,
    with_images: bool = True,
) -> list[dict]:
    doc = pymupdf.open(path)
    try:
        blocks, page_sizes = _collect_blocks(doc)
        images = _collect_images(doc) if with_images else []
        page_count = doc.page_count
    finally:
        doc.close()

    body = _body_size(blocks)
    body_font = _body_font(blocks, body)
    _mark_furniture(blocks, page_count)
    blocks = _split_inline_drop_caps(blocks, body)
    blocks = _merge_drop_caps(blocks, body)
    _classify(blocks, body, body_font)

    ordered: list[Block] = []
    by_page: dict[int, list[Block]] = defaultdict(list)
    for b in blocks:
        by_page[b.page].append(b)
    for pno in sorted(by_page):
        w, _ = page_sizes[pno]
        ordered.extend(_reading_order(by_page[pno], w))

    ordered = _merge_heading_runs(ordered, body)

    articles: list[Article] | None = None
    if use_llm and llm.available():
        try:
            groups = llm.group_with_llm(_digest_blocks(ordered))
            if groups:
                candidate = _articles_from_llm_groups(groups, ordered, page_sizes)
                # Nur uebernehmen, wenn die KI-Gruppierung den Text nicht verliert.
                heuristic_chars = sum(
                    b.char_count for b in ordered if b.kind == "body"
                )
                if sum(len(a.text) for a in candidate) > heuristic_chars * 0.7:
                    articles = candidate
        except Exception as exc:  # Netzfehler darf den Import nicht kippen
            print(f"LLM-Gruppierung uebersprungen: {exc}")

    if articles is None:
        articles = group_articles(ordered, page_sizes, min_chars=min_chars)

    if images:
        _attach_captions(images, ordered)
        _assign_images(articles, images, page_sizes)

    return [a.to_dict(i + 1) for i, a in enumerate(articles)]
