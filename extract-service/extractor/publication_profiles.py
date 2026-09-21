"""Wiederkehrende Heftstruktur auswerten.

Publikationsprofile beschreiben nur belastbare, redaktionell bestaetigte
Konventionen. Die allgemeine PDF-Erkennung bleibt fuer andere Titel unveraendert.
Welches Profil greift, entscheidet die Kennung der Publikation (`slug`).

ZUERST! hat vorne immer dieselbe Semantik: Umschlagseiten sind kein Artikel,
gedruckte Seite 3 ist das Editorial, Seite 4 das Inhaltsverzeichnis und ab Seite
5 beginnt der regulaere Inhalt. Rubriken stehen als Versalien im Kolumnentitel.

Die DMZ (Deutsche Militaerzeitschrift) folgt vorne derselben Seitenlogik:
Seite 3 Editorial, Seite 4 Inhalt, ab Seite 5 Inhalt. Das Inhaltsverzeichnis
steht in zwei Spalten mit fetter Seitenzahl links, darueber die Rubrik in 13 pt,
darunter der Titel in 11,5 pt und ein Anreisser in Grundschrift. Jede Seite
traegt oben den Rubriknamen als Kolumnentitel in Gross- und Kleinschreibung,
16 pt fett. Der Umschlag liegt als zwei Doppelseiten vor (U4|U1, U2|U3); das
Einlesen halber Quellseiten regelt die Seitenliste, nicht dieses Profil.
Alle Masse sind am Musterheft DMZ 170 (A4, 84 Seiten) genommen.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import replace

from .model import LayoutLine, SourceBlock, SourceImage, TocHint

_NUMBER = re.compile(r"^\s*(\d{1,3})\s*$")
_TRAILING_NUMBER = re.compile(r"^(.*?)\s+(\d{1,3})\s*$")
_LEADING_NUMBER = re.compile(r"^\s*(\d{1,3})\s+(.+?)\s*$")


def is_zuerst(publication_slug: str | None) -> bool:
    slug = (publication_slug or "").strip().lower()
    return slug == "zuerst" or slug.startswith("zuerst-")


def is_dmz(publication_slug: str | None) -> bool:
    slug = (publication_slug or "").strip().lower()
    return (
        slug == "dmz"
        or slug.startswith("dmz-")
        or slug.startswith("deutsche-militaerzeitschrift")
    )


def profile_for(publication_slug: str | None) -> str | None:
    """Name des Profils, das fuer diese Publikation gilt, sonst None."""
    if is_zuerst(publication_slug):
        return "zuerst"
    if is_dmz(publication_slug):
        return "dmz"
    return None


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


def _content_pages(pages: list[dict]) -> set[int]:
    """Kanonische Seiten, die Artikel tragen: ab gedruckter Seite 3, ohne Inhalt.

    Beide Profile teilen diese Konvention: Umschlagseiten und das gedruckte
    Inhaltsverzeichnis (Seite 4) liefern weder Artikel noch Bilder.
    """
    return {
        int(page["index"])
        for page in pages
        if page.get("role") == "content"
        and str(page.get("printedLabel") or "").isdigit()
        and int(str(page["printedLabel"])) >= 3
        and int(str(page["printedLabel"])) != 4
    }


def apply_profile(
    blocks: list[SourceBlock],
    images: list[SourceImage],
    pages: list[dict],
    publication_slug: str | None,
) -> tuple[list[SourceBlock], list[SourceImage], list[TocHint]]:
    """Nicht-inhaltliche Seiten entfernen und Strukturhinweise liefern."""
    profile = profile_for(publication_slug)
    if profile == "zuerst":
        return _apply_zuerst(blocks, images, pages, publication_slug)
    if profile == "dmz":
        return _apply_dmz(blocks, images, pages, publication_slug)
    return blocks, images, []


# --- ZUERST! ---------------------------------------------------------------


def _apply_zuerst(
    blocks: list[SourceBlock],
    images: list[SourceImage],
    pages: list[dict],
    publication_slug: str | None,
) -> tuple[list[SourceBlock], list[SourceImage], list[TocHint]]:
    toc = extract_zuerst_toc(blocks, pages, publication_slug)
    numeric = _numeric_pages(pages)
    toc_page = numeric.get(4)
    allowed = _content_pages(pages)
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


# --- DMZ -------------------------------------------------------------------

# Kolumnentitel: eine Zeile, 16 pt fett, Oberkante bei 3,7 % der Seitenhoehe.
_DMZ_HEAD_MAX_Y = 0.06
_DMZ_HEAD_SIZE = (14.5, 17.5)
# Inhaltsverzeichnis: Seitenzahl 18 pt, Rubrik 13 pt, Titel 11,5 pt, alle fett.
_DMZ_TOC_NUMBER_SIZE = 16.0
_DMZ_TOC_RUBRIC_SIZE = (12.5, 13.5)
_DMZ_TOC_TITLE_SIZE = (11.0, 12.5)
_DMZ_TOC_LINE_TOLERANCE = 0.014     # Titelzeile und Seitenzahl auf einer Hoehe
_DMZ_TOC_RUBRIC_GAP = 0.012         # Rubrik steht unmittelbar ueber dem Titel
_DMZ_TOC_COLUMNS = ((0.045, 0.49), (0.51, 0.96))   # Klickflaechen je Spalte
_DMZ_TOC_BOTTOM = 0.84              # darunter steht die Eigenanzeige
# Rubrikseiten mit vielen kurzen Meldungen; ihre Ueberschriften bleiben getrennt.
_DMZ_SPLIT_SECTION = "rubriken"
_DMZ_SPLIT_WORDS = {"nachrichten", "kalenderblatt", "buchbesprechungen", "leserbriefe"}


def _letters(text: str) -> str:
    return re.sub(r"[^A-Za-zÄÖÜäöüß]", "", text)


def _lines_of(block: SourceBlock) -> tuple[LayoutLine, ...]:
    """Satzzeilen eines Blocks; ohne Zeileninventar gilt der Block als Zeile."""
    if block.layout_lines:
        return block.layout_lines
    return (
        LayoutLine(
            page_index=block.page_index,
            text=block.text,
            x0=block.x0,
            y0=block.y0,
            x1=block.x1,
            y1=block.y1,
            size=block.size,
            max_size=block.max_size,
            font=block.font,
            bold=block.bold,
            column=block.column,
        ),
    )


def _dmz_is_running_head_line(line: LayoutLine) -> bool:
    letters = _letters(line.text)
    return (
        line.y0 < _DMZ_HEAD_MAX_Y
        and line.bold
        and _DMZ_HEAD_SIZE[0] <= line.max_size <= _DMZ_HEAD_SIZE[1]
        and 3 <= len(letters) <= 40
        and len(line.text.strip()) <= 40
    )


def _dmz_is_running_head(block: SourceBlock) -> bool:
    lines = _lines_of(block)
    return len(lines) == 1 and _dmz_is_running_head_line(lines[0])


def _dmz_without_running_head(block: SourceBlock) -> SourceBlock:
    """Kolumnentitel abtrennen, wenn er mit der Schlagzeile darunter verschmolz.

    Steht die Schlagzeile dicht unter dem Kolumnentitel und in aehnlicher
    Schrift, liefert die Zeilenbildung beides als einen Block. Der Rest bleibt
    mit seiner eigenen Geometrie stehen.
    """
    lines = block.layout_lines
    if len(lines) < 2 or not _dmz_is_running_head_line(lines[0]):
        return block
    head = lines[0].text.strip()
    text = block.text
    if text.startswith(head):
        text = text[len(head) :].lstrip()
    rest = lines[1:]
    sizes = [line.size for line in rest if line.size]
    return replace(
        block,
        text=text,
        x0=min(line.x0 for line in rest),
        y0=min(line.y0 for line in rest),
        x1=max(line.x1 for line in rest),
        size=statistics.median(sizes) if sizes else block.size,
        max_size=max(line.max_size for line in rest),
        layout_lines=rest,
    )


def _dmz_is_rubric_line(line: LayoutLine) -> bool:
    text = line.text.strip()
    return (
        line.bold
        and _DMZ_TOC_RUBRIC_SIZE[0] <= line.size <= _DMZ_TOC_RUBRIC_SIZE[1]
        and line.max_size < _DMZ_TOC_NUMBER_SIZE
        and not any(ch.isdigit() for ch in text)
        and 3 <= len(_letters(text)) <= 40
    )


def _dmz_is_title_line(line: LayoutLine) -> bool:
    return (
        line.bold
        and _DMZ_TOC_TITLE_SIZE[0] <= line.size < _DMZ_TOC_TITLE_SIZE[1]
        # Eine Zeile mit eingebauter Seitenzahl traegt die 18 pt der Zahl und
        # wird als eigener Eintrag gelesen, nicht als Titel einer anderen Zahl.
        and line.max_size < _DMZ_TOC_NUMBER_SIZE
        and not _NUMBER.match(line.text)
    )


def _dmz_splits(section: str | None, title: str) -> bool:
    if (section or "").casefold() == _DMZ_SPLIT_SECTION:
        return True
    first = title.split()[0].casefold() if title.split() else ""
    return first.split("/")[0] in _DMZ_SPLIT_WORDS


def extract_dmz_toc(
    blocks: list[SourceBlock], pages: list[dict], publication_slug: str | None
) -> list[TocHint]:
    """Eintraege samt Zielseite und Trefferflaeche aus gedruckter Seite 4 lesen.

    Gelesen wird zeilenweise, weil der PDF-Export Rubrik und Titel meist zu
    einem Block verbindet und die Seitenzahl daneben als eigenen Block liefert.
    Eine Seitenzahl gehoert zu den fetten Titelzeilen auf gleicher Hoehe rechts
    von ihr; ein mehrzeiliger Titel wird zusammengesetzt. In der Rubrikenliste
    steht die Zahl mit in der Zeile ("24 Kalenderblatt Ereignisse").

    Das Editorial auf Seite 3 nennt das Verzeichnis nicht. Es kommt als
    Eintrag ohne Klickflaeche dazu, damit die Seite ein eigener Artikel bleibt.
    """
    if not is_dmz(publication_slug):
        return []
    page_by_print = _numeric_pages(pages)
    toc_page = page_by_print.get(4)
    if toc_page is None:
        return []

    lines = [
        line
        for block in blocks
        if block.page_index == toc_page
        for line in _lines_of(block)
        if not _dmz_is_running_head_line(line) and line.y0 < _DMZ_TOC_BOTTOM
    ]
    columns: tuple[list[LayoutLine], list[LayoutLine]] = ([], [])
    for line in lines:
        columns[0 if line.x0 < 0.5 else 1].append(line)

    # (Spalte, Oberkante, Unterkante, gedruckte Seite, Titel, Rubrik)
    found: list[tuple[int, float, float, int, str, str | None]] = []
    for column_index, column in enumerate(columns):
        column.sort(key=lambda line: (line.y0, line.x0))
        section: str | None = None
        consumed: set[int] = set()
        for line in column:
            text = line.text.strip()
            if _NUMBER.match(text) and line.max_size >= _DMZ_TOC_NUMBER_SIZE:
                center = (line.y0 + line.y1) / 2
                titles = sorted(
                    (
                        other
                        for other in column
                        if other is not line
                        and id(other) not in consumed
                        and other.x0 > line.x1
                        and _dmz_is_title_line(other)
                        and abs((other.y0 + other.y1) / 2 - center)
                        <= _DMZ_TOC_LINE_TOLERANCE
                    ),
                    key=lambda other: other.y0,
                )
                if not titles:
                    continue
                consumed.update(id(other) for other in titles)
                title = " ".join(other.text.strip() for other in titles)
                top = min([line.y0] + [other.y0 for other in titles])
                bottom = max([line.y1] + [other.y1 for other in titles])
                rubric = next(
                    (
                        other
                        for other in column
                        if _dmz_is_rubric_line(other)
                        and 0 <= titles[0].y0 - other.y1 <= _DMZ_TOC_RUBRIC_GAP
                    ),
                    None,
                )
                if rubric is not None:
                    top = min(top, rubric.y0)
                found.append((column_index, top, bottom, int(text), title, section))
            elif (
                (match := _LEADING_NUMBER.match(text))
                and line.bold
                and line.max_size >= _DMZ_TOC_NUMBER_SIZE
            ):
                found.append(
                    (column_index, line.y0, line.y1, int(match.group(1)),
                     match.group(2).strip(), section)
                )
            elif _dmz_is_rubric_line(line):
                # Gilt fuer alle folgenden Eintraege der Spalte, bis eine neue
                # Rubrikzeile kommt — ob sie allein steht oder direkt ueber dem
                # naechsten Titel.
                section = text

    unique: dict[tuple[int, str], tuple[int, float, float, int, str, str | None]] = {}
    for row in found:
        if row[3] in page_by_print and row[4]:
            unique[(row[3], row[4].casefold())] = row
    rows = sorted(unique.values(), key=lambda row: (row[0], row[1]))

    hints: list[TocHint] = []
    editorial = page_by_print.get(3)
    if editorial is not None and any(b.page_index == editorial for b in blocks):
        hints.append(TocHint("Editorial", editorial, None, 0.0, 0.0, 0.0, 0.0))
    for index, (column_index, top, bottom, printed, title, section) in enumerate(rows):
        next_in_column = next(
            (row for row in rows[index + 1 :] if row[0] == column_index), None
        )
        y1 = (
            next_in_column[1] - 0.003
            if next_in_column is not None
            else min(bottom + 0.06, _DMZ_TOC_BOTTOM)
        )
        x0, x1 = _DMZ_TOC_COLUMNS[column_index]
        hints.append(
            TocHint(
                label=title[:300],
                page_index=page_by_print[printed],
                toc_page_index=toc_page,
                x0=x0,
                y0=max(0.0, top - 0.004),
                x1=x1,
                y1=max(bottom, y1),
                section=section,
                split_headings=_dmz_splits(section, title),
            )
        )
    return hints


def _apply_dmz(
    blocks: list[SourceBlock],
    images: list[SourceImage],
    pages: list[dict],
    publication_slug: str | None,
) -> tuple[list[SourceBlock], list[SourceImage], list[TocHint]]:
    toc = extract_dmz_toc(blocks, pages, publication_slug)
    numeric = _numeric_pages(pages)
    toc_page = numeric.get(4)
    allowed = _content_pages(pages)
    if not allowed:
        return blocks, images, toc

    filtered_blocks = [
        _dmz_without_running_head(block)
        for block in blocks
        if block.page_index in allowed
        and block.page_index != toc_page
        and not _dmz_is_running_head(block)
    ]
    filtered_images = [
        image
        for image in images
        if image.page_index in allowed and image.page_index != toc_page
    ]
    return filtered_blocks, filtered_images, toc
