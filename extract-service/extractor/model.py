"""Kanonisches Zwischenmodell.

PDF und IDML liefern verschiedene Signale. Beide werden auf `SourceBlock`
abgebildet; erst danach entscheidet der Artikelaufbau. Ein weiterer Analyzer
(Docling, Adobe) kann spaeter denselben Typ liefern, ohne dass sich das
Domaenenmodell aendert.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

BlockType = Literal[
    "heading",
    "subheading",
    "lead",
    "paragraph",
    "quote",
    "caption",
    "box",
    "table",
    "other",
]


@dataclass(frozen=True)
class TableCell:
    """Eine Zelle, so wie sie in HTML steht: verbundene Zellen nur einmal.

    Mehrere Absaetze einer Zelle trennt ein Zeilenumbruch.
    """

    text: str
    header: bool = False
    row_span: int = 1
    col_span: int = 1
    # Der Satz hebt die Zelle mit einer eigenen Schriftfarbe hervor, etwa die
    # Zeile des Mannes, um den es im Artikel geht.
    emphasis: bool = False


@dataclass(frozen=True)
class TableData:
    """Eine Tabelle aus dem Satz, Zeile fuer Zeile.

    Jede Zeile nennt nur die Zellen, die in ihr beginnen. Eine Zelle mit
    `row_span` 2 fehlt deshalb in der Zeile darunter, genau wie in HTML.
    """

    rows: tuple[tuple[TableCell, ...], ...]
    header_rows: int = 0
    # Relative Spaltenbreiten aus dem Satz, zusammen 1.0.
    column_widths: tuple[float, ...] = ()

    @property
    def column_count(self) -> int:
        if self.column_widths:
            return len(self.column_widths)
        return max((sum(c.col_span for c in row) for row in self.rows), default=0)

    def to_payload(self) -> dict:
        """Die Form, die Convex als `table` eines Artikelblocks erwartet.

        Voreinstellungen (keine Kopfzelle, Spanne 1) fallen weg; das haelt die
        Bloecke klein.
        """

        def zelle(c: TableCell) -> dict:
            out: dict = {"text": c.text}
            if c.header:
                out["header"] = True
            if c.row_span > 1:
                out["rowSpan"] = c.row_span
            if c.col_span > 1:
                out["colSpan"] = c.col_span
            if c.emphasis:
                out["emphasis"] = True
            return out

        return {
            "headerRows": self.header_rows,
            **({"columnWidths": list(self.column_widths)} if self.column_widths else {}),
            "rows": [[zelle(c) for c in row] for row in self.rows],
        }

    def as_text(self) -> str:
        """Flacher Text fuer Suche und Zeichenzaehlung: Zellen mit " | "."""
        return "\n".join(
            " | ".join(c.text.replace("\n", " ") for c in row) for row in self.rows
        )


@dataclass(frozen=True)
class LayoutLine:
    """Eine sichtbare Satzzeile, bevor sie zu einem PDF-Block verschmilzt.

    Diese Daten verlassen den Import-Worker nicht. Sie erhalten die
    Absatzgrenzen und die genaue Geometrie der Textebene.
    """

    page_index: int
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float = 0.0
    max_size: float = 0.0
    font: str = ""
    bold: bool = False
    column: int = 0
    continues_word: bool = False


@dataclass
class SourceBlock:
    """Ein zusammenhaengendes Stueck Text mit Herkunft."""

    page_index: int           # kanonische Leserseite, 0-basiert
    text: str
    x0: float                 # normiert 0..1
    y0: float
    x1: float
    y1: float
    size: float = 0.0         # Schriftgroesse in Punkt
    max_size: float = 0.0
    font: str = ""
    bold: bool = False
    kind: BlockType = "paragraph"
    origin: Literal["pdf", "idml"] = "pdf"
    story_id: str | None = None
    frame_id: str | None = None
    style_name: str | None = None
    # Nur bei Bloecken aus dem Satz: der Textrahmen, in dem der Absatz steht,
    # als Rechteck auf der Seite. Wo genau ein Absatz innerhalb des Rahmens
    # sitzt, weiss die IDML nicht — der Rahmen selbst dagegen steht fest, und
    # er ist die richtige Trefferflaeche fuer den Sprung in den Artikel.
    frame_box: tuple[float, float, float, float] | None = None
    column: int = 0
    drop: bool = False        # Beiwerk: Seitenzahl, Kolumnentitel, Slug
    confidence: float = 1.0
    # Das PDF markiert eine Silbentrennung am Zeilenende mit einem weichen
    # Trennstrich. Beim spaeteren Zusammenziehen einzelner Satzzeilen muss
    # bekannt bleiben, dass das Folgewort ohne Leerzeichen anschliesst.
    continues_word: bool = False
    layout_lines: tuple[LayoutLine, ...] = field(default_factory=tuple)
    # Nur bei `kind == "table"`: die Tabelle selbst. `text` traegt dann ihren
    # flachen Text, damit Suche und Zaehlungen weiter funktionieren.
    table: TableData | None = None

    @property
    def char_count(self) -> int:
        return len(self.text)


@dataclass
class SourceImage:
    page_index: int
    x0: float
    y0: float
    x1: float
    y1: float
    caption: str | None = None
    # Dateiname des im Satz platzierten Bildes (`Links/...`), wenn die IDML ihn
    # nennt. Liegt dieselbe Datei umgewandelt im Medienspeicher, ist sie die
    # bessere Vorlage als der Ausschnitt aus der gerenderten Seite.
    link: str | None = None
    # Welcher Teil der verknuepften Datei im Rahmen steht (u0, v0, u1, v1 als
    # Anteile des Originals). None heisst: ganzes Bild oder unbekannt.
    crop: tuple[float, float, float, float] | None = None
    # 1-basierte Position des Reader-Blocks, nach dem das Bild stehen soll.
    # None laesst die bisherige geometrische Rueckfalllogik aktiv.
    after_block_order: int | None = None
    after_block: SourceBlock | None = field(default=None, repr=False, compare=False)


@dataclass
class TocHint:
    """Ein Eintrag des gedruckten Inhaltsverzeichnisses mit Klickflaeche."""

    label: str
    page_index: int
    # Seite des gedruckten Inhaltsverzeichnisses mit der Klickflaeche. None,
    # wenn der Eintrag dort nicht steht (etwa ein Editorial, das ein Profil
    # nur aus der Heftkonvention kennt): dann gibt es keine Trefferflaeche.
    toc_page_index: int | None
    x0: float
    y0: float
    x1: float
    y1: float
    section: str | None = None
    # Rubrikeintraege wie "Politikmeldungen" markieren einen Seitenbereich,
    # in dem mehrere kurze Artikel stehen. Deren eigene Ueberschriften duerfen
    # nicht vom TOC-Anker zu einem einzigen Artikel zusammengezogen werden.
    split_headings: bool = False


@dataclass
class AssembledArticle:
    title: str
    blocks: list[SourceBlock] = field(default_factory=list)
    images: list[SourceImage] = field(default_factory=list)
    subtitle: str | None = None
    author: str | None = None
    teaser: str | None = None
    confidence: float = 1.0

    @property
    def pages(self) -> list[int]:
        pages = sorted({b.page_index for b in self.blocks})
        return pages or [0]

    @property
    def source(self) -> str:
        """Woher der Text stammt: aus dem Satz, aus der PDF-Textebene oder beides."""
        if not self.blocks:
            return "pdf"
        aus_satz = sum(1 for b in self.blocks if b.origin == "idml")
        if aus_satz == len(self.blocks):
            return "idml"
        return "hybrid" if aus_satz else "pdf"
