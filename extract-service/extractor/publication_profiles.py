"""Wiederkehrende Heftstruktur auswerten.

Publikationsprofile beschreiben nur belastbare, redaktionell bestaetigte
Konventionen. Die allgemeine PDF-Erkennung bleibt fuer andere Titel unveraendert.
ZUERST! hat vorne immer dieselbe Semantik: Umschlagseiten sind kein Artikel,
gedruckte Seite 3 ist das Editorial, Seite 4 das Inhaltsverzeichnis und ab Seite
5 beginnt der regulaere Inhalt.
"""

from __future__ import annotations

import re
from dataclasses import replace

from .model import SourceBlock, SourceImage, TocHint

_NUMBER = re.compile(r"^\s*(\d{1,3})\s*$")
_TRAILING_NUMBER = re.compile(r"^(.*?)\s+(\d{1,3})\s*$")


def is_zuerst(publication_slug: str | None) -> bool:
    slug = (publication_slug or "").strip().lower()
    return slug == "zuerst" or slug.startswith("zuerst-")


def _numeric_pages(pages: list[dict]) -> dict[int, int]:
    out: dict[int, int] = {}
    for page in pages:
        label = str(page.get("printedLabel") or "").strip()
        if label.isdigit():
            out[int(label)] = int(page["index"])
    return out


def _section_and_title(text: str) -> tuple[str | None, str]:
    """Vorangestellte Rubrik von einem in denselben Block geratenen Titel loesen."""
    words = text.strip().split()
    prefix: list[str] = []
    while words:
        token = re.sub(r"[^A-Za-zÄÖÜ]", "", words[0])
        if len(token) < 3 or token.upper() != token:
            break
        prefix.append(words.pop(0))
    if prefix and words:
        return " ".join(prefix), " ".join(words)
    return None, text.strip()


def extract_zuerst_toc(
    blocks: list[SourceBlock], pages: list[dict], publication_slug: str | None
) -> list[TocHint]:
    """Eintraege samt Zielseite und Trefferflaeche aus gedruckter Seite 4 lesen.

    Die mittlere Bildspalte enthaelt nur hervorgehobene Dubletten. Relevant sind
    die beiden aeusseren Textspalten. Seitennummer und Titel stehen auf gleicher
    Hoehe; gelegentlich hat der PDF-Export beide schon zu einem Block verbunden.
    """
    if not is_zuerst(publication_slug):
        return []
    page_by_print = _numeric_pages(pages)
    toc_page = page_by_print.get(4)
    if toc_page is None:
        return []

    candidates = [
        b
        for b in blocks
        if b.page_index == toc_page
        and (b.x0 < 0.33 or b.x0 > 0.66)
        and b.y0 < 0.95
    ]
    number_blocks = [b for b in candidates if _NUMBER.match(b.text)]
    found: list[tuple[SourceBlock, int, str | None, str]] = []

    # Getrennte Seitennummern: Titelblock beruehrt dieselbe Grundzeile.
    for number in number_blocks:
        printed = int(number.text.strip())
        if printed not in page_by_print:
            continue
        same_side = [
            b
            for b in candidates
            if b is not number
            and not _NUMBER.match(b.text)
            and ((b.x0 < 0.33) == (number.x0 < 0.33))
            and b.y0 - 0.004 <= (number.y0 + number.y1) / 2 <= b.y1 + 0.004
            and b.max_size >= 9.5
        ]
        if not same_side:
            continue
        title_block = min(
            same_side,
            key=lambda b: abs((b.y0 + b.y1) / 2 - (number.y0 + number.y1) / 2),
        )
        section, title = _section_and_title(title_block.text)
        if title and title.upper() != title:
            found.append((title_block, printed, section, title))

    # Verbundene Zeile wie "Migrantifa gegen Connewitz 35".
    for block in candidates:
        match = _TRAILING_NUMBER.match(block.text)
        if not match or block.max_size < 9.5:
            continue
        printed = int(match.group(2))
        if printed not in page_by_print:
            continue
        section, title = _section_and_title(match.group(1))
        if title and title.upper() != title:
            found.append((block, printed, section, title))

    # PDF-Zerlegung kann denselben Treffer auf zwei Wegen liefern.
    unique: dict[tuple[int, str], tuple[SourceBlock, int, str | None, str]] = {}
    for row in found:
        unique[(row[1], row[3].casefold())] = row
    rows = sorted(unique.values(), key=lambda row: (row[1], row[0].y0))

    hints: list[TocHint] = []
    for index, (block, printed, section, title) in enumerate(rows):
        left = block.x0 < 0.33
        next_same_column = next(
            (
                other
                for other, *_ in rows[index + 1 :]
                if (other.x0 < 0.33) == left and other.y0 > block.y0
            ),
            None,
        )
        y1 = min(block.y1 + 0.045, (next_same_column.y0 - 0.003) if next_same_column else 0.945)
        hints.append(
            TocHint(
                label=title[:300],
                page_index=page_by_print[printed],
                toc_page_index=toc_page,
                x0=0.052 if left else 0.672,
                y0=max(0.0, block.y0 - 0.004),
                x1=0.325 if left else 0.942,
                y1=max(block.y1, y1),
                section=section,
                split_headings=title.casefold().endswith("meldungen"),
            )
        )
    return hints


def apply_profile(
    blocks: list[SourceBlock],
    images: list[SourceImage],
    pages: list[dict],
    publication_slug: str | None,
) -> tuple[list[SourceBlock], list[SourceImage], list[TocHint]]:
    """Nicht-inhaltliche Seiten entfernen und Strukturhinweise liefern."""
    if not is_zuerst(publication_slug):
        return blocks, images, []

    toc = extract_zuerst_toc(blocks, pages, publication_slug)
    numeric = _numeric_pages(pages)
    toc_page = numeric.get(4)
    allowed = {
        int(page["index"])
        for page in pages
        if page.get("role") == "content"
        and str(page.get("printedLabel") or "").isdigit()
        and int(str(page["printedLabel"])) >= 3
        and int(str(page["printedLabel"])) != 4
    }
    # Wenn die Labels unvollstaendig sind, bleibt die generische Erkennung
    # besser als ein leeres Heft.
    if not allowed:
        return blocks, images, toc
    def is_running_section_head(block: SourceBlock) -> bool:
        letters = re.sub(r"[^A-Za-zÄÖÜ]", "", block.text)
        return (
            block.y0 < 0.065
            and 3 <= len(letters) <= 30
            and letters == letters.upper()
        )

    # Manche PDF-Seiten liefern Rubrik und erste Schlagzeile als denselben
    # Textblock (z. B. "POLITIK Richterbund: …"). Die auf anderen Seiten frei
    # stehenden Rubrikköpfe liefern dafür eine sichere, heftinterne Wortliste.
    running_labels = {
        b.text.strip()
        for b in blocks
        if b.page_index in allowed and is_running_section_head(b)
    }

    def without_running_prefix(block: SourceBlock) -> SourceBlock:
        if block.y0 >= 0.1:
            return block
        for label in sorted(running_labels, key=len, reverse=True):
            prefix = f"{label} "
            if block.text.startswith(prefix):
                return replace(block, text=block.text[len(prefix) :].lstrip())
        return block

    filtered_blocks = [
        without_running_prefix(b)
        for b in blocks
        if b.page_index in allowed and not is_running_section_head(b)
    ]
    printed_page_six = numeric.get(6)

    def is_page_six_cartoon(image: SourceImage) -> bool:
        # Die feste Karikatur unten auf Seite 6 ist Rubrikschmuck. Sie bleibt
        # auf der originalen Druckseite, gehoert aber nicht in den Artikelmodus.
        return (
            image.page_index == printed_page_six
            and image.y0 >= 0.59
            and image.x0 >= 0.3
            and image.x1 >= 0.9
        )

    filtered_images = [
        i
        for i in images
        if i.page_index in allowed and not is_page_six_cartoon(i)
    ]

    # Die Karte "Deutsche Gebietsverluste 1919/1945" auf gedruckter Seite 9
    # besteht im PDF aus Vektorformen und taucht deshalb nicht in der Liste der
    # eingebetteten Rasterbilder auf. Als belegte Heft-Ausnahme wird ihr
    # sichtbarer Rahmen wie ein normales Bild aus der gerenderten Seite
    # ausgeschnitten. Die Ueberdeckungspruefung verhindert eine Dublette, falls
    # ein spaeterer Export die Karte doch als Bild liefert.
    printed_page_nine = numeric.get(9)
    page_nine_present = printed_page_nine is not None and any(
        block.page_index == printed_page_nine for block in blocks
    )
    has_page_nine_map = any(
        image.page_index == printed_page_nine
        and image.x0 < 0.45
        and image.x1 > 0.85
        and image.y0 > 0.58
        for image in filtered_images
    )
    if page_nine_present and printed_page_nine is not None and not has_page_nine_map:
        filtered_images.append(
            SourceImage(
                page_index=printed_page_nine,
                x0=0.357,
                y0=0.625,
                x1=0.952,
                y1=0.936,
                caption="Deutsche Gebietsverluste 1919/1945",
            )
        )
    if toc_page is not None:
        filtered_blocks = [b for b in filtered_blocks if b.page_index != toc_page]
        filtered_images = [i for i in filtered_images if i.page_index != toc_page]
    return filtered_blocks, filtered_images, toc
