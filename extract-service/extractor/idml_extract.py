"""IDML (InDesign Markup) auswerten.

Eine Story ist ein durchgehender Text ueber alle verketteten Rahmen hinweg —
das ist das stabilste Signal dafuer, was zusammengehoert. Sie ist aber nicht
automatisch ein ganzer Artikel: Ueberschrift, Vorspann, Haupttext und
Infokasten liegen oft in getrennten Stories.

Deshalb liefert dieses Modul Bloecke mit Story- und Formatangabe, und der
Artikelaufbau entscheidet damit. Die Seitengeometrie kommt weiter aus dem PDF.

Eine binaere .indd-Datei kann hier nicht gelesen werden; dafuer braucht es den
IDML-Export aus InDesign.
"""

from __future__ import annotations

import io
import re
import zipfile

from lxml import etree

from .model import SourceBlock
from .textutil import clean_text, first_sentence  # noqa: F401  (Re-Export)

HEADING_HINTS = ("ueberschrift", "überschrift", "headline", "titel", "title", "head")
KICKER_HINTS = ("dachzeile", "kicker", "rubrik")
SUBTITLE_HINTS = ("unterzeile", "subtitle", "vorspann", "lead", "teaser")
AUTHOR_HINTS = ("autor", "author", "byline", "verfasser")
CAPTION_HINTS = ("bildunterschrift", "caption", "legende", "bildtext")

MAX_ENTRY_BYTES = 40 * 1024 * 1024


def _safe_members(zf: zipfile.ZipFile, prefix: str) -> list[str]:
    """Nur Eintraege innerhalb des Archivs zulassen (kein Pfad-Ausbruch)."""
    out = []
    for info in zf.infolist():
        name = info.filename
        if not name.startswith(prefix):
            continue
        if name.startswith("/") or ".." in name.split("/"):
            continue
        if info.file_size > MAX_ENTRY_BYTES:
            continue
        out.append(name)
    return sorted(out)


def _style_kind(style: str) -> str:
    s = style.lower()
    if any(h in s for h in HEADING_HINTS):
        return "heading"
    if any(h in s for h in KICKER_HINTS):
        return "subheading"
    if any(h in s for h in SUBTITLE_HINTS):
        return "lead"
    if any(h in s for h in CAPTION_HINTS):
        return "caption"
    if any(h in s for h in AUTHOR_HINTS):
        return "other"
    return "paragraph"


def extract_idml_blocks(idml_bytes: bytes) -> list[SourceBlock]:
    """Alle Absaetze aller Stories als Bloecke, in Dateireihenfolge."""
    blocks: list[SourceBlock] = []
    with zipfile.ZipFile(io.BytesIO(idml_bytes)) as zf:
        for name in _safe_members(zf, "Stories/"):
            root = etree.fromstring(zf.read(name))
            # Die Wurzel heisst ebenfalls Story (idPkg), traegt aber kein Self.
            story = next(
                (el for el in root.iter("{*}Story") if el.get("Self")), None
            )
            story_id = story.get("Self") if story is not None else name

            for psr in root.iter("{*}ParagraphStyleRange"):
                style = re.sub(
                    r"^ParagraphStyle/", "", psr.get("AppliedParagraphStyle", "") or ""
                )
                parts: list[str] = []
                for node in psr.iter():
                    tag = etree.QName(node).localname
                    if tag == "Content" and node.text:
                        parts.append(node.text)
                    elif tag == "Br":
                        parts.append("\n")
                text = clean_text("".join(parts))
                if not text:
                    continue
                blocks.append(
                    SourceBlock(
                        page_index=0,
                        text=text,
                        x0=0.0,
                        y0=0.0,
                        x1=1.0,
                        y1=0.0,
                        kind=_style_kind(style),
                        origin="idml",
                        story_id=story_id,
                        style_name=style or None,
                    )
                )
    return blocks


def story_of_frames(idml_bytes: bytes) -> dict[str, list[str]]:
    """Textrahmen je Story — zeigt die Verkettung ueber Seiten hinweg."""
    mapping: dict[str, list[str]] = {}
    with zipfile.ZipFile(io.BytesIO(idml_bytes)) as zf:
        for name in _safe_members(zf, "Spreads/"):
            root = etree.fromstring(zf.read(name))
            for frame in root.iter("{*}TextFrame"):
                story = frame.get("ParentStory")
                if not story:
                    continue
                mapping.setdefault(story, []).append(frame.get("Self", ""))
    return mapping
