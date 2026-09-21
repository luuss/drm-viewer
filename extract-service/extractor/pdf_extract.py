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

from .image_regions import drop_repeating, read_raw_images, select_regions
from .model import LayoutLine, SourceBlock, SourceImage
from .textutil import (
    SOFT_HYPHEN,
    clean_text,
    glue_dropcap,
    is_probably_heading,
    normalize_compare,
)

LINE_TOLERANCE = 2.2       # Punkte: Zeilen mit dieser Abweichung gelten als eine
BLOCK_GAP_FACTOR = 1.45    # Zeilenabstand, ab dem ein neuer Block beginnt


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


def _line_fields(words: list[dict]) -> dict:
    """Die abgeleiteten Angaben einer Zeile aus ihren Woertern bestimmen."""
    words = sorted(words, key=lambda w: w["x0"])
    sizes = [float(w.get("size", 0) or 0) for w in words]
    fonts = [str(w.get("fontname", "")) for w in words]
    font = Counter(fonts).most_common(1)[0][0] if fonts else ""
    return {
        "top": min(w["top"] for w in words),
        "bottom": max(w["bottom"] for w in words),
        "x0": min(w["x0"] for w in words),
        "x1": max(w["x1"] for w in words),
        "words": words,
        "text": " ".join(w["text"] for w in words),
        "size": statistics.median(sizes) if sizes else 0.0,
        "max_size": max(sizes) if sizes else 0.0,
        "font": font,
        "bold": "bold" in font.lower(),
    }


def _split_line_at_gaps(line: dict) -> list[dict]:
    """Eine Zeile nur an echtem Weissraum in Spaltenstuecke zerlegen.

    Frueher wurden die Woerter erst den Spalten zugeordnet und danach zu Zeilen
    gebaut. Eine Ueberschrift, die ueber zwei Spalten laeuft, zerfiel dabei
    zwangslaeufig: aus "Sozialabgaben bald ueber 50 Prozent?" wurden zwei
    Artikel. Umgekehrt muessen nebeneinanderliegende Spalten getrennt bleiben,
    sonst verzahnt sich ihr Text.

    Beides unterscheidet der Abstand zwischen zwei Woertern: innerhalb einer
    Zeile liegt er bei einem Bruchteil der Schriftgroesse, an einer
    Spaltengrenze bei einem Vielfachen davon. Gemessen am Testheft sind es 4 pt
    innerhalb einer Ueberschrift gegenueber 22 bis 160 pt an einer Spaltenkante.
    """
    words = sorted(line["words"], key=lambda w: w["x0"])
    if len(words) < 2:
        return [line]
    size = line.get("size") or 0.0
    # Der Schwellwert waechst mit der Schriftgroesse, bleibt aber ueber dem
    # breitesten gewoehnlichen Wortabstand.
    threshold = max(10.0, size * 1.2)

    pieces: list[list[dict]] = [[words[0]]]
    for previous, current in zip(words, words[1:]):
        if current["x0"] - previous["x1"] >= threshold:
            pieces.append([current])
        else:
            pieces[-1].append(current)
    if len(pieces) == 1:
        return [line]
    return [_line_fields(piece) for piece in pieces]


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
        raw_text = "\n".join(l["text"] for l in current)
        text = glue_dropcap(clean_text(raw_text))
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
                continues_word=raw_text.rstrip().endswith(SOFT_HYPHEN),
                layout_lines=tuple(
                    LayoutLine(
                        page_index=page_index,
                        text=l["text"],
                        x0=l["x0"] / page_width,
                        y0=l["top"] / page_height,
                        x1=l["x1"] / page_width,
                        y1=l["bottom"] / page_height,
                        size=l["size"],
                        max_size=l["max_size"],
                        font=l["font"],
                        bold=l["bold"],
                        continues_word=l["text"].rstrip().endswith(SOFT_HYPHEN),
                    )
                    for l in current
                ),
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
        # Im kompakten Meldungssatz steht eine farbige, fette Ueberschrift oft
        # fast ohne Abstand ueber dem Fliesstext und nur 1,2 pt groesser. Der
        # Wechsel der Betonung ist dort das verlaesslichere Trennsignal.
        same_emphasis = line["bold"] == prev["bold"]
        if (
            gap > line_height * BLOCK_GAP_FACTOR
            or not same_column
            or not similar_size
            or not same_emphasis
        ):
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
    if len(tokens) < 4:
        return False
    singles = sum(1 for t in tokens if len(t) <= 2)
    if singles / len(tokens) <= 0.6:
        return False
    # Ein laengeres Wort rettet den Satz: dann ist es eher eine kurze Zeile
    # mit Abkuerzungen als zerfallene Zierschrift.
    lange = sum(1 for t in tokens if len(t) >= 4)
    return lange <= 1


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
            # Die optionale LLM-Stufe rekonstruiert ausschliesslich aus diesen
            # Zeilen. Die grosse Initiale darf deshalb beim deterministischen
            # Zusammenkleben nicht aus dem Zeileninventar verschwinden.
            c.layout_lines = b.layout_lines + c.layout_lines
            used.add(i)
    return [b for k, b in enumerate(blocks) if k not in used]


def classify(blocks: list[SourceBlock], body: float, body_font: str) -> None:
    for b in blocks:
        if b.drop:
            continue
        t = b.text.strip().lower()
        foreign_font = bool(body_font) and body_font != b.font
        # Ein Initialbuchstabe treibt nur max_size hoch. Median, Schrift und
        # Gewicht bleiben die des Fliesstexts; daraus darf weder eine neue
        # Ueberschrift noch eine Unterzeile entstehen.
        drop_cap_paragraph = (
            b.max_size >= body * 1.7
            and b.size <= body * 1.15
            and not b.bold
            and not foreign_font
        )
        compact_heading = (
            b.bold
            and foreign_font
            and b.size >= body * 1.08
            and b.char_count <= 140
            and is_probably_heading(b.text)
        )
        if t.startswith(("foto:", "fotos:", "bild:", "grafik:", "abb.:")):
            b.kind = "caption"
        elif b.max_size <= body * 0.9:
            b.kind = "caption"
        elif compact_heading:
            # ZUERST!-Meldungen nutzen rechts eine nur wenig groessere, fette
            # Grotesk. Sie ist typografisch eindeutig, obwohl 12 zu 10,8 pt
            # die allgemeine Groessenschwelle knapp unterschreitet.
            b.kind = "heading"
        elif foreign_font and b.max_size <= body * 1.12 and b.char_count <= 400:
            # Schmuckzitat oder Bildunterschrift im Hausfont, kein Fliesstext.
            b.kind = "quote" if b.char_count < 200 else "caption"
        elif (
            not drop_cap_paragraph
            and b.max_size >= body * 1.45
            # Eine Initiale am Absatzanfang treibt die groesste Schriftgroesse
            # hoch, ohne dass der Absatz eine Ueberschrift waere. Eine echte
            # Ueberschrift ist durchgaengig gross oder typografisch betont.
            and (b.size >= body * 1.25 or b.bold or foreign_font)
            and is_probably_heading(b.text)
        ):
            b.kind = "heading"
        elif (
            not drop_cap_paragraph
            and b.max_size >= body * 1.12
            and b.char_count <= 260
            and is_probably_heading(b.text)
        ):
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


def _body_word_size(words_by_page: dict[int, list[dict]]) -> float:
    """Grundschriftgroesse des Dokuments, nach Zeichen gewichtet.

    Ueber alle Seiten gemessen, nicht je Seite: eine Bildstrecke oder eine
    Anzeigenseite haette sonst ihre eigene "Grundschrift".
    """
    counter: Counter[float] = Counter()
    for words in words_by_page.values():
        for w in words:
            counter[round(float(w.get("size", 0) or 0), 1)] += len(w.get("text", ""))
    return counter.most_common(1)[0][0] if counter else 10.0


def _words_on_visible_page(page, words: list[dict]) -> tuple[list[dict], float, float]:
    """Woerter auf die sichtbare TrimBox verschieben und daran abschneiden.

    pdfplumber verwendet bereits Koordinaten mit Ursprung oben links. Seine
    TrimBox ist deshalb ebenfalls (links, oben, rechts, unten).
    """
    box = page.trimbox or page.cropbox or page.mediabox or page.bbox
    left, top, right, bottom = (float(value) for value in box)
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        left, top, right, bottom = (0.0, 0.0, float(page.width), float(page.height))
        width, height = float(page.width), float(page.height)

    visible: list[dict] = []
    for word in words:
        x0 = max(left, float(word["x0"]))
        x1 = min(right, float(word["x1"]))
        y0 = max(top, float(word["top"]))
        y1 = min(bottom, float(word["bottom"]))
        if x1 <= x0 or y1 <= y0:
            continue
        local = dict(word)
        local.update(x0=x0 - left, x1=x1 - left, top=y0 - top, bottom=y1 - top)
        visible.append(local)
    return visible, width, height


def extract_images(
    pdf_bytes: bytes,
    page_map: list[tuple[int, int]],
    words_by_page: dict[int, list[tuple[float, float, float, float]]],
    body_words_by_page: dict[int, list[tuple[float, float, float, float]]] | None = None,
) -> list[SourceImage]:
    """Bildbereiche aller Seiten bestimmen.

    Die Arbeit steckt in `image_regions`: Beschnittpfad verrechnen, Anschnitt
    abschneiden, Hintergruende und Masken verwerfen, Lagen zusammenfassen. Hier
    bleibt nur die Klammer ueber alle Seiten, weil Seitenschmuck erst im
    Vergleich mehrerer Seiten auffaellt.
    """
    raw_by_page, trims = read_raw_images(pdf_bytes, page_map)
    regions: dict[int, list[tuple]] = {}
    for canonical_index, raw_images in raw_by_page.items():
        words = words_by_page.get(canonical_index, [])
        body = (body_words_by_page or {}).get(canonical_index)
        trim = trims.get(canonical_index, (0.0, 0.0, 1.0, 1.0))
        regions[canonical_index] = select_regions(raw_images, words, trim, body)
    regions = drop_repeating(regions, len(raw_by_page))

    out: list[SourceImage] = []
    for canonical_index in sorted(regions):
        for x0, y0, x1, y1 in regions[canonical_index]:
            out.append(
                SourceImage(
                    page_index=canonical_index,
                    x0=max(0.0, x0),
                    y0=max(0.0, y0),
                    x1=min(1.0, x1),
                    y1=min(1.0, y1),
                )
            )
    return out


CAPTION_GAP = 0.055        # Abstand Bildunterkante zur Unterschrift


def attach_captions(images: list[SourceImage], blocks: list[SourceBlock]) -> None:
    """Bildunterschrift nur uebernehmen, wenn sie raeumlich zum Bild gehoert.

    Zwei Bedingungen, beide notwendig: die Unterschrift steht dicht unter dem
    Bild, und sie liegt in dessen Spaltenbreite. Ohne die zweite Bedingung
    faengt ein Bild die Unterschrift des Nachbarbildes ein; ohne die erste
    wandert irgendein Kleintext von weiter unten herauf.

    Ausserdem darf eine Unterschrift nur einmal vergeben werden — das naeher
    stehende Bild bekommt sie.
    """
    captions = [b for b in blocks if b.kind == "caption" and not b.drop]
    vergeben: dict[int, tuple[float, SourceImage]] = {}
    for img in images:
        for index, c in enumerate(captions):
            if c.page_index != img.page_index:
                continue
            gap = c.y0 - img.y1
            if gap < -0.012 or gap > CAPTION_GAP:
                continue
            breite = max(img.x1 - img.x0, 1e-6)
            overlap = min(c.x1, img.x1) - max(c.x0, img.x0)
            if overlap < breite * 0.5:
                continue
            # Die Unterschrift darf nicht breiter sein als das Bild plus eine
            # Spaltenbreite — sonst ist es ein Fliesstextrest.
            if (c.x1 - c.x0) > breite * 1.6:
                continue
            bisher = vergeben.get(index)
            if bisher is None or gap < bisher[0]:
                vergeben[index] = (gap, img)

    for index, (_gap, img) in vergeben.items():
        text = captions[index].text.strip()
        if text.lower().startswith(("foto:", "fotos:", "bild:", "grafik:")):
            continue
        if img.caption is None:
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
    # Woerter je Seite. Die Bilderkennung braucht sie, um Masken und
    # Hintergruende von echten Bildern zu unterscheiden.
    raw_words_by_page: dict[int, list[dict]] = {}
    page_sizes: dict[int, tuple[float, float]] = {}
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
            words, page_width, page_height = _words_on_visible_page(page, words)
            raw_words_by_page[canonical_index] = words
            page_sizes[canonical_index] = (page_width, page_height)
            starts = _column_starts(words)
            gutters = [] if starts else _detect_gutters(words, page_width)
            # Erst Zeilen ueber die ganze Seite, dann an echtem Weissraum in
            # Spaltenstuecke zerlegen. Die umgekehrte Reihenfolge zerschnitt
            # jede Ueberschrift, die ueber mehrere Spalten laeuft.
            segments: list[dict] = []
            for line in _words_to_lines(words):
                segments.extend(_split_line_at_gaps(line))
            by_column: dict[int, list[dict]] = defaultdict(list)
            for piece in segments:
                column = (
                    _column_by_start(piece["x0"], starts)
                    if starts
                    else _column_of((piece["x0"] + piece["x1"]) / 2, gutters)
                )
                by_column[column].append(piece)
            for column in sorted(by_column):
                lines = sorted(by_column[column], key=lambda l: (round(l["top"], 1), l["x0"]))
                column_blocks = _lines_to_blocks(
                    lines, page_width, page_height, canonical_index
                )
                for b in column_blocks:
                    b.column = column
                    if b.layout_lines:
                        b.layout_lines = tuple(
                            LayoutLine(
                                **{
                                    **line.__dict__,
                                    "column": column,
                                }
                            )
                            for line in b.layout_lines
                        )
                blocks.extend(column_blocks)

    # Die Bildgeometrie kommt aus PDFium, weil dort der Beschnittpfad steht.
    body_size = _body_word_size(raw_words_by_page)
    words_by_page: dict[int, list[tuple[float, float, float, float]]] = {}
    body_words_by_page: dict[int, list[tuple[float, float, float, float]]] = {}
    for canonical_index, words in raw_words_by_page.items():
        width, height = page_sizes[canonical_index]
        alle = []
        satz = []
        for w in words:
            rect = (
                w["x0"] / width,
                w["top"] / height,
                w["x1"] / width,
                w["bottom"] / height,
            )
            alle.append(rect)
            # Nur Satz in Grundschriftgroesse zaehlt als Fliesstext (gedrehter
            # Satz ist oben schon draussen). Kartenbeschriftung, Anzeigensatz
            # und Bildunterschriften sind kleiner gesetzt und duerfen im Bild
            # stehen, ohne es zu verwerfen.
            if abs(float(w.get("size", 0) or 0) - body_size) < body_size * 0.15:
                satz.append(rect)
        words_by_page[canonical_index] = alle
        body_words_by_page[canonical_index] = satz
    images = extract_images(pdf_bytes, page_map, words_by_page, body_words_by_page)
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
