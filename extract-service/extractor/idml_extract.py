"""IDML (InDesign Markup) in Artikel zerlegen.

IDML ist der verlaessliche Weg: eine Story im IDML ist genau ein durchgehender
Artikeltext ueber alle verketteten Textrahmen und Seiten hinweg. Die Grenzen,
an denen die PDF-Heuristik raten muss, stehen hier bereits fest.

InDesign liefert IDML ueber Datei -> Exportieren -> InDesign Markup (IDML).
Eine binaere .indd-Datei kann dieser Weg nicht lesen.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass

from lxml import etree

from .textutil import clean_text, first_sentence

NS = {"idPkg": "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"}

HEADING_HINTS = (
    "ueberschrift",
    "überschrift",
    "headline",
    "titel",
    "title",
    "head",
    "dachzeile",
    "kicker",
)
SUBTITLE_HINTS = ("unterzeile", "subtitle", "vorspann", "lead", "teaser")
AUTHOR_HINTS = ("autor", "author", "byline", "verfasser")


@dataclass
class Para:
    style: str
    text: str

    def style_is(self, hints: tuple[str, ...]) -> bool:
        s = self.style.lower()
        return any(h in s for h in hints)


def _story_paragraphs(root: etree._Element) -> list[Para]:
    paras: list[Para] = []
    for psr in root.iter("{*}ParagraphStyleRange"):
        style = psr.get("AppliedParagraphStyle", "") or ""
        style = re.sub(r"^ParagraphStyle/", "", style)
        parts: list[str] = []
        for node in psr.iter():
            tag = etree.QName(node).localname
            if tag == "Content" and node.text:
                parts.append(node.text)
            elif tag == "Br":
                parts.append("\n")
        text = clean_text("".join(parts))
        if text:
            paras.append(Para(style=style, text=text))
    return paras


def _page_range_for_story(story_id: str, spread_roots: list[etree._Element]) -> tuple[int, int]:
    """Seiten finden, auf denen Textrahmen dieser Story liegen."""
    pages: list[int] = []
    for spread_index, spread in enumerate(spread_roots):
        page_ids = [p.get("Self") for p in spread.iter("{*}Page")]
        for frame in spread.iter("{*}TextFrame"):
            if frame.get("ParentStory") != story_id:
                continue
            # Seitennummer naeherungsweise ueber die Spread-Position.
            base = spread_index * max(1, len(page_ids))
            pages.append(base + 1)
    if not pages:
        return (1, 1)
    return (min(pages), max(pages))


def extract_idml(path: str, min_chars: int = 200) -> list[dict]:
    with zipfile.ZipFile(path) as z:
        story_names = [n for n in z.namelist() if n.startswith("Stories/")]
        spread_names = sorted(n for n in z.namelist() if n.startswith("Spreads/"))
        spread_roots = [etree.fromstring(z.read(n)) for n in spread_names]

        articles: list[dict] = []
        order = 0
        for name in sorted(story_names):
            root = etree.fromstring(z.read(name))
            story_el = next(root.iter("{*}Story"), None)
            story_id = story_el.get("Self") if story_el is not None else ""
            paras = _story_paragraphs(root)
            if not paras:
                continue

            title = ""
            subtitle = None
            author = None
            body: list[str] = []
            for p in paras:
                if not title and p.style_is(HEADING_HINTS) and len(p.text) < 200:
                    title = p.text
                elif subtitle is None and p.style_is(SUBTITLE_HINTS):
                    subtitle = p.text
                elif author is None and p.style_is(AUTHOR_HINTS):
                    author = p.text
                else:
                    body.append(p.text)

            text = clean_text("\n\n".join(body))
            if len(text) < min_chars and not title:
                continue
            if not title:
                title = text.split("\n")[0][:120] or "Ohne Titel"
                text = text[len(title) :].strip() or text

            page_start, page_end = _page_range_for_story(story_id, spread_roots)
            order += 1
            articles.append(
                {
                    "order": order,
                    "title": title[:300],
                    "subtitle": subtitle,
                    "author": author,
                    "teaser": first_sentence(text) if text else None,
                    "text": text,
                    "pageStart": page_start,
                    "pageEnd": page_end,
                    "boxes": [],
                    "source": "idml",
                }
            )
    return articles
