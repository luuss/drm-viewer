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
