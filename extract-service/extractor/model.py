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
    "heading", "subheading", "lead", "paragraph", "quote", "caption", "box", "other"
]


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
    column: int = 0
    drop: bool = False        # Beiwerk: Seitenzahl, Kolumnentitel, Slug
    confidence: float = 1.0
    # Das PDF markiert eine Silbentrennung am Zeilenende mit einem weichen
    # Trennstrich. Beim spaeteren Zusammenziehen einzelner Satzzeilen muss
    # bekannt bleiben, dass das Folgewort ohne Leerzeichen anschliesst.
    continues_word: bool = False
    layout_lines: tuple[LayoutLine, ...] = field(default_factory=tuple)

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
