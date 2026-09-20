"""PDF-Seiten in kanonische Bloecke zerlegen.

Textebene statt Texterkennung: Satzdateien aus InDesign bringen echte Zeichen
mit. Gelesen wird mit `pdfplumber` (MIT) statt PyMuPDF (AGPL).

Der Weg: Woerter -> Zeilen -> Bloecke, dann Beiwerk aussortieren, Initialen
loesen, Spalten und Lesereihenfolge bestimmen, Bloecke einordnen.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict

import pdfplumber

from .model import SourceBlock, SourceImage
from .textutil import clean_text, glue_dropcap, is_probably_heading, normalize_compare

LINE_TOLERANCE = 2.2       # Punkte: Zeilen mit dieser Abweichung gelten als eine
BLOCK_GAP_FACTOR = 1.45    # Zeilenabstand, ab dem ein neuer Block beginnt
MIN_IMAGE_SIDE = 0.06      # Anteil der Seite, ab dem ein Bild zaehlt


def _detect_gutters(words: list[dict], page_width: float) -> list[float]:
    """Senkrechte Weissraeume finden, an denen Spalten getrennt sind.

    Ohne diesen Schritt fasst die Zeilenbildung Woerter aus benachbarten
    Spalten zusammen, weil sie auf gleicher Hoehe stehen — der Text zweier
    Artikel verzahnt sich dann unlesbar.
    """
    if not words:
        return []
    bin_size = 2.0
    bins = int(page_width / bin_size) + 2
    occupied = [False] * bins
    for w in words:
        start = max(0, int(w["x0"] / bin_size))
        end = min(bins - 1, int(w["x1"] / bin_size))
        for i in range(start, end + 1):
            occupied[i] = True

    min_gutter_bins = max(3, int(8.0 / bin_size))
    gutters: list[float] = []
    run_start = None
    for i, taken in enumerate(occupied):
        if not taken:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None and i - run_start >= min_gutter_bins:
                # Raender zaehlen nicht als Spaltentrenner.
                center = (run_start + i) / 2 * bin_size
                if center > page_width * 0.08 and center < page_width * 0.92:
                    gutters.append(center)
            run_start = None
    return gutters


def _column_of(x_center: float, gutters: list[float]) -> int:
    return sum(1 for g in gutters if x_center > g)


def _column_starts(words: list[dict]) -> list[float]:
    """Linke Spaltenkanten aus den Wortanfaengen des Fliesstextes ableiten.

    Auf Bildstrecken versagt die Suche nach senkrechtem Weissraum, weil Fotos
    ueber die Spalten laufen. Die linken Kanten des Satzes sind dagegen stabil.
    """
    sizes = [float(w.get("size", 0) or 0) for w in words if w.get("size")]
    if not sizes:
        return []
    body = statistics.median(sizes)
    body_words = [
        w for w in words if abs(float(w.get("size", 0) or 0) - body) < body * 0.18
    ]
    if len(body_words) < 30:
        return []

    bin_size = 4.0
    counts: Counter[int] = Counter()
    for w in body_words:
        counts[int(w["x0"] / bin_size)] += 1
    threshold = max(4, len(body_words) * 0.03)
    peaks = sorted(b for b, n in counts.items() if n >= threshold)
    if not peaks:
        return []

    starts: list[float] = []
    for b in peaks:
        x = b * bin_size
        if starts and x - starts[-1] < 30:
            continue
        starts.append(x)
    return starts if len(starts) >= 2 else []


def _column_by_start(x0: float, starts: list[float]) -> int:
    index = 0
    for i, s in enumerate(starts):
        if x0 + 6 >= s:
            index = i
    return index


def _words_to_lines(words: list[dict]) -> list[dict]:
    lines: list[dict] = []
    for w in sorted(words, key=lambda w: (round(w["top"], 1), w["x0"])):
        placed = False
        for line in reversed(lines[-4:]):
            if abs(line["top"] - w["top"]) <= LINE_TOLERANCE:
                line["words"].append(w)
                line["x0"] = min(line["x0"], w["x0"])
                line["x1"] = max(line["x1"], w["x1"])
                line["bottom"] = max(line["bottom"], w["bottom"])
                placed = True
                break
        if not placed:
            lines.append(
                {
                    "top": w["top"],
                    "bottom": w["bottom"],
                    "x0": w["x0"],
                    "x1": w["x1"],
                    "words": [w],
                }
            )
    for line in lines:
        line["words"].sort(key=lambda w: w["x0"])
        line["text"] = " ".join(w["text"] for w in line["words"])
        sizes = [float(w.get("size", 0) or 0) for w in line["words"]]
        line["size"] = statistics.median(sizes) if sizes else 0.0
        line["max_size"] = max(sizes) if sizes else 0.0
        fonts = [str(w.get("fontname", "")) for w in line["words"]]
        line["font"] = Counter(fonts).most_common(1)[0][0] if fonts else ""
        line["bold"] = "bold" in line["font"].lower()
    lines.sort(key=lambda l: (round(l["top"], 1), l["x0"]))
    return lines


def _lines_to_blocks(lines: list[dict], page_width: float, page_height: float,
                     page_index: int) -> list[SourceBlock]:
    blocks: list[SourceBlock] = []
    current: list[dict] = []

    def flush() -> None:
        if not current:
            return
        text = glue_dropcap(clean_text("\n".join(l["text"] for l in current)))
        if not text:
            current.clear()
            return
        sizes = [l["size"] for l in current if l["size"]]
        maxes = [l["max_size"] for l in current if l["max_size"]]
        fonts = Counter(l["font"] for l in current)
        bold_chars = sum(len(l["text"]) for l in current if l["bold"])
        blocks.append(
            SourceBlock(
                page_index=page_index,
                text=text,
                x0=min(l["x0"] for l in current) / page_width,
                y0=min(l["top"] for l in current) / page_height,
                x1=max(l["x1"] for l in current) / page_width,
                y1=max(l["bottom"] for l in current) / page_height,
                size=statistics.median(sizes) if sizes else 0.0,
                max_size=max(maxes) if maxes else 0.0,
                font=fonts.most_common(1)[0][0] if fonts else "",
                bold=bold_chars > 0.6 * max(1, sum(len(l["text"]) for l in current)),
            )
        )
        current.clear()

    for line in lines:
        if not current:
            current.append(line)
            continue
        prev = current[-1]
        gap = line["top"] - prev["bottom"]
        line_height = max(prev["bottom"] - prev["top"], 1.0)
        same_column = not (line["x1"] < prev["x0"] - 5 or line["x0"] > prev["x1"] + 5)
        similar_size = abs(line["size"] - prev["size"]) < max(1.2, prev["size"] * 0.25)
        if gap > line_height * BLOCK_GAP_FACTOR or not same_column or not similar_size:
            flush()
        current.append(line)
    flush()
    return blocks


def _body_size(blocks: list[SourceBlock]) -> float:
    counter: Counter[float] = Counter()
    for b in blocks:
        counter[round(b.size, 1)] += b.char_count
    return counter.most_common(1)[0][0] if counter else 10.0


def _body_font(blocks: list[SourceBlock], body: float) -> str:
    counter: Counter[str] = Counter()
    for b in blocks:
        if abs(b.size - body) < 0.6:
            counter[b.font] += b.char_count
    return counter.most_common(1)[0][0] if counter else ""


def _looks_shattered(text: str) -> bool:
    """Erkennt zerfallenen Satz wie "n h e c r e e g r r".

    Gedrehter Text am Umschlagruecken kommt beim Auslesen als lose Einzelzeichen
    an und mischt sich mit der Nachbarzeile. Als Inhalt ist das wertlos.
    """
    tokens = text.split()
    if len(tokens) < 8:
        return False
    singles = sum(1 for t in tokens if len(t) <= 2)
    return singles / len(tokens) > 0.6


def _looks_doubled(text: str) -> bool:
    """Erkennt Ueberdruck wie "zzuueerrsstt": jedes Zeichen steht doppelt."""
    t = re.sub(r"\s+", "", text)
    if len(t) < 8 or len(t) % 2 != 0:
        return False
    return all(t[i] == t[i + 1] for i in range(0, len(t) - 1, 2))


def mark_furniture(blocks: list[SourceBlock], page_count: int) -> None:
    """Kolumnentitel, Seitenzahlen und Setzer-Slugs sind kein Artikelinhalt."""
    pages_present = len({b.page_index for b in blocks}) or 1
    buckets: dict[tuple[str, int], list[SourceBlock]] = defaultdict(list)
    for b in blocks:
        if b.char_count > 120:
            continue
        key = (re.sub(r"\d+", "", normalize_compare(b.text))[:40], int(b.y0 * 50))
        if not key[0]:
            continue
        buckets[key].append(b)
    threshold = max(3, min(page_count, pages_present) * 0.25)
    for group in buckets.values():
        if len({b.page_index for b in group}) >= threshold:
            for b in group:
                b.drop = True

    for b in blocks:
        t = b.text.strip()
        if t.isdigit() and len(t) <= 3:
            b.drop = True
        elif ".indd" in t.lower() or _looks_doubled(t) or _looks_shattered(t):
            b.drop = True
        elif len(t) <= 2:
            b.drop = True


def split_drop_caps(blocks: list[SourceBlock], body: float) -> list[SourceBlock]:
    """Initialen an den Textanfang ziehen.

    Sicheres Merkmal: der Anschluss beginnt klein ("eutsche Politiker ...").
    Ohne die Pruefung klebt der Buchstabe an der Ueberschrift daneben.
    """
    used: set[int] = set()
    by_page: dict[int, list[int]] = defaultdict(list)
    for i, b in enumerate(blocks):
        by_page[b.page_index].append(i)

    for i, b in enumerate(blocks):
        t = b.text.strip()
        if len(t) > 2 or not t.isalpha() or b.max_size < body * 1.7:
            continue
        best, best_dist = None, 1e9
        for j in by_page[b.page_index]:
            if j == i:
                continue
            c = blocks[j]
            if c.max_size > body * 1.25 or c.char_count < 40:
                continue
            head = c.text.lstrip()[:1]
            if not head or not head.islower():
                continue
            if c.y0 > b.y1 + 0.01 or c.y1 < b.y0 - 0.01:
                continue
            if c.x0 < b.x0 - 0.01 or c.x0 > b.x1 + 0.06:
                continue
            dist = abs(c.y0 - b.y0) + abs(c.x0 - b.x0)
            if dist < best_dist:
                best, best_dist = j, dist
        if best is not None:
            c = blocks[best]
            c.text = t + c.text
            c.x0 = min(c.x0, b.x0)
            c.y0 = min(c.y0, b.y0)
            used.add(i)
    return [b for k, b in enumerate(blocks) if k not in used]


def classify(blocks: list[SourceBlock], body: float, body_font: str) -> None:
    for b in blocks:
        if b.drop:
            continue
        t = b.text.strip().lower()
        foreign_font = bool(body_font) and body_font != b.font
        if t.startswith(("foto:", "fotos:", "bild:", "grafik:", "abb.:")):
            b.kind = "caption"
        elif b.max_size <= body * 0.9:
            b.kind = "caption"
        elif foreign_font and b.max_size <= body * 1.12 and b.char_count <= 400:
            # Schmuckzitat oder Bildunterschrift im Hausfont, kein Fliesstext.
            b.kind = "quote" if b.char_count < 200 else "caption"
        elif b.max_size >= body * 1.45 and is_probably_heading(b.text):
            b.kind = "heading"
        elif b.max_size >= body * 1.12 and b.char_count <= 260 and is_probably_heading(b.text):
            b.kind = "subheading" if b.char_count <= 120 else "lead"
        else:
            b.kind = "paragraph"


def assign_columns(blocks: list[SourceBlock]) -> None:
    """Spalten je Seite ueber die Mitten gruppieren."""
    by_page: dict[int, list[SourceBlock]] = defaultdict(list)
    for b in blocks:
        by_page[b.page_index].append(b)
    for page_blocks in by_page.values():
        centers = sorted((b.x0 + b.x1) / 2 for b in page_blocks)
        splits = [
            (a + c) / 2
            for a, c in zip(centers, centers[1:])
            if c - a > 0.12
        ]
        for b in page_blocks:
            center = (b.x0 + b.x1) / 2
            b.column = sum(1 for s in splits if center > s)


def reading_order(blocks: list[SourceBlock]) -> list[SourceBlock]:
    """Breite Elemente zuerst, danach Spalte fuer Spalte von oben nach unten."""
    ordered: list[SourceBlock] = []
    by_page: dict[int, list[SourceBlock]] = defaultdict(list)
    for b in blocks:
        by_page[b.page_index].append(b)
    for page in sorted(by_page):
        page_blocks = by_page[page]
        wide = [b for b in page_blocks if (b.x1 - b.x0) > 0.62]
        rest = [b for b in page_blocks if b not in wide]
        wide.sort(key=lambda b: b.y0)
        rest.sort(key=lambda b: (b.column, b.y0))
        ordered.extend(wide + rest)
    return ordered


def extract_images(page, page_index: int, page_width: float,
                   page_height: float) -> list[SourceImage]:
    out: list[SourceImage] = []
    for img in page.images:
        x0 = max(0.0, img["x0"] / page_width)
        x1 = min(1.0, img["x1"] / page_width)
        y0 = max(0.0, img["top"] / page_height)
        y1 = min(1.0, img["bottom"] / page_height)
        if (x1 - x0) < MIN_IMAGE_SIDE or (y1 - y0) < MIN_IMAGE_SIDE:
            continue
        out.append(SourceImage(page_index=page_index, x0=x0, y0=y0, x1=x1, y1=y1))
    return out


def attach_captions(images: list[SourceImage], blocks: list[SourceBlock]) -> None:
    """Die Unterschrift steht unter dem Bild und ueberlappt es waagerecht."""
    captions = [b for b in blocks if b.kind == "caption"]
    for img in images:
        best, best_gap = None, 1e9
        for c in captions:
            if c.page_index != img.page_index:
                continue
            gap = c.y0 - img.y1
            if gap < -0.01 or gap > 0.09:
                continue
            overlap = min(c.x1, img.x1) - max(c.x0, img.x0)
            if overlap < (img.x1 - img.x0) * 0.35:
                continue
            if gap < best_gap:
                best, best_gap = c, gap
        if best is not None:
            text = best.text.strip()
            if not text.lower().startswith(("foto:", "fotos:", "bild:", "grafik:")):
                img.caption = text[:400]


def extract_pdf_pages(
    pdf_bytes: bytes,
    page_map: list[tuple[int, int]],
) -> tuple[list[SourceBlock], list[SourceImage]]:
    """Bloecke und Bilder fuer die angegebenen Seiten lesen.

    `page_map` bildet Quellseite (0-basiert) auf kanonische Leserseite ab.
    """
    import io

    blocks: list[SourceBlock] = []
    images: list[SourceImage] = []
    wanted = dict(page_map)

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for source_index, canonical_index in sorted(wanted.items()):
            if source_index >= len(pdf.pages):
                continue
            page = pdf.pages[source_index]
            words = page.extract_words(
                extra_attrs=["size", "fontname", "upright"], keep_blank_chars=False
            )
            # Gedrehter Satz (Preisleiste am Umschlagruecken, Bildnachweise)
            # gehoert nicht in den Lesefluss und zerreisst sonst die Zeilen.
            words = [w for w in words if w.get("upright", True)]
            # Winzige Zeichen sind gedrehte Bildnachweise am Rand. Sie zerreissen
            # sonst die Zeilen des Fliesstextes daneben.
            words = [w for w in words if float(w.get("size", 0) or 0) >= 4.5]
            starts = _column_starts(words)
            gutters = [] if starts else _detect_gutters(words, page.width)
            by_column: dict[int, list[dict]] = defaultdict(list)
            for w in words:
                column = (
                    _column_by_start(w["x0"], starts)
                    if starts
                    else _column_of((w["x0"] + w["x1"]) / 2, gutters)
                )
                by_column[column].append(w)
            for column in sorted(by_column):
                lines = _words_to_lines(by_column[column])
                column_blocks = _lines_to_blocks(
                    lines, page.width, page.height, canonical_index
                )
                for b in column_blocks:
                    b.column = column
                blocks.extend(column_blocks)
            images.extend(
                extract_images(page, canonical_index, page.width, page.height)
            )
    return blocks, images


def prepare_blocks(
    blocks: list[SourceBlock], images: list[SourceImage], page_count: int
) -> list[SourceBlock]:
    """Aufraeumen, einordnen, in Lesereihenfolge bringen."""
    if not blocks:
        return []
    body = _body_size(blocks)
    body_font = _body_font(blocks, body)
    mark_furniture(blocks, page_count)
    blocks = split_drop_caps(blocks, body)
    classify(blocks, body, body_font)
    ordered = reading_order(blocks)
    attach_captions(images, ordered)
    return ordered
