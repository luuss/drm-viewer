"""Aus kanonischen Bloecken Artikel bauen.

Kein "eine Seite gleich ein Artikel". Ein Artikel beginnt an einer Ueberschrift
und laeuft ueber Spalten und Seiten weiter, bis die naechste Ueberschrift
kommt. Zusaetzlich zaehlen Schriftgroessen, Satzfortsetzung und, falls
vorhanden, die Story-Zuordnung aus IDML.
"""

from __future__ import annotations

import re

from .model import AssembledArticle, SourceBlock, SourceImage
from .textutil import clean_text, first_sentence, is_meaningful

MIN_ARTICLE_CHARS = 280
AUTHOR_PATTERN = re.compile(
    r"^(von|text|interview)[: ]\s*[A-ZÄÖÜ][\wäöüß.\- ]{2,60}$", re.IGNORECASE
)


def _merge_heading_runs(blocks: list[SourceBlock]) -> list[SourceBlock]:
    """Mehrzeilige Ueberschriften kommen als mehrere Bloecke an."""
    out: list[SourceBlock] = []
    for b in blocks:
        if out:
            prev = out[-1]
            overlap = min(prev.x1, b.x1) - max(prev.x0, b.x0)
            span = max(prev.x1 - prev.x0, b.x1 - b.x0, 0.01)
            if (
                prev.kind == b.kind == "heading"
                and prev.page_index == b.page_index
                and abs(prev.max_size - b.max_size) < 1.5
                and overlap > span * 0.45
                and -0.005 <= b.y0 - prev.y1 < 0.035
            ):
                prev.text = f"{prev.text} {b.text}".strip()
                prev.x1 = max(prev.x1, b.x1)
                prev.y1 = max(prev.y1, b.y1)
                continue
        out.append(b)
    return out


def _continues_sentence(prev: SourceBlock | None, block: SourceBlock) -> bool:
    if prev is None:
        return False
    tail = prev.text.rstrip()[-1:] if prev.text else ""
    head = block.text.lstrip()[:1] if block.text else ""
    return bool(tail) and tail not in ".!?:»“\"" and head.islower()


def assemble(
    blocks: list[SourceBlock],
    images: list[SourceImage] | None = None,
    story_hints: dict[str, str] | None = None,
) -> list[AssembledArticle]:
    """Bloecke in Lesereihenfolge zu Artikeln gruppieren."""
    usable = _merge_heading_runs([b for b in blocks if not b.drop])
    articles: list[AssembledArticle] = []
    current: AssembledArticle | None = None
    prev_body: SourceBlock | None = None

    for block in usable:
        if block.kind == "caption":
            # Bildunterschriften gehoeren nicht in den Fliesstext.
            continue

        starts_new = block.kind == "heading"
        if starts_new and current is not None:
            body_chars = sum(
                b.char_count for b in current.blocks if b.kind == "paragraph"
            )
            # Eine Ueberschrift direkt nach einer Ueberschrift ist eine Dachzeile.
            if body_chars == 0 and current.blocks:
                if is_meaningful(current.title):
                    current.subtitle = current.title
                current.title = block.text.strip()
                continue

        if starts_new or current is None:
            current = AssembledArticle(title=block.text.strip() if starts_new else "")
            if not starts_new:
                # Text vor der ersten Ueberschrift: eigener Anfang.
                current.title = block.text.strip().split("\n")[0][:120]
                current.blocks.append(block)
            else:
                current.blocks.append(block)
            articles.append(current)
            prev_body = block if not starts_new else None
            continue

        if block.kind in ("subheading", "lead") and not any(
            b.kind == "paragraph" for b in current.blocks
        ):
            if current.subtitle is None and is_meaningful(block.text):
                current.subtitle = block.text.strip()
            if is_meaningful(block.text):
                current.blocks.append(block)
            continue

        if block.kind == "paragraph" and AUTHOR_PATTERN.match(block.text.strip()):
            current.author = block.text.strip()
            continue

        # Fortsetzung eines angefangenen Satzes bindet stark an den Vorgaenger.
        if _continues_sentence(prev_body, block) and current.blocks:
            pass
        current.blocks.append(block)
        if block.kind == "paragraph":
            prev_body = block

    merged = _merge_small(articles)
    _attach_images(merged, images or [])
    for a in merged:
        body = "\n\n".join(b.text for b in a.blocks if b.kind == "paragraph")
        a.teaser = first_sentence(clean_text(body)) if body else None
        if not a.title:
            a.title = (body[:80] or "Ohne Titel").split("\n")[0]
        a.confidence = _confidence(a)
    return merged


def _merge_small(articles: list[AssembledArticle]) -> list[AssembledArticle]:
    """Bruchstuecke ohne Titel an den Vorgaenger haengen."""
    out: list[AssembledArticle] = []
    for a in articles:
        chars = sum(b.char_count for b in a.blocks if b.kind == "paragraph")
        if out and chars < MIN_ARTICLE_CHARS and not a.title.strip():
            out[-1].blocks.extend(a.blocks)
            continue
        out.append(a)
    return out


MAX_IMAGES_PER_ARTICLE = 12
NEAR_GAP = 0.22  # senkrechter Abstand, ab dem ein Block nichts mehr mit dem Bild zu tun hat


def _image_score(article: AssembledArticle, img: SourceImage) -> float:
    """Wie gut passt das Bild zu diesem Artikel auf dieser Seite?

    Der reine Mittenabstand, wie er vorher benutzt wurde, greift im
    Magazinsatz daneben: er zieht ein Bild zum Nachbarartikel, sobald dessen
    Ueberschrift zufaellig naeher steht als der eigene Fliesstext. Im Satz gilt
    dagegen die Spalte. Ein Bild liegt in der Spaltenbreite seines Artikels und
    stoesst dort oben oder unten an dessen Text.

    Deshalb zaehlen drei Dinge, in dieser Reihenfolge:
    waagerechte Ueberdeckung (Spalte), senkrechter Abstand, und als
    Stichentscheid die Textmenge des Artikels auf der Seite.
    """
    breite = max(img.x1 - img.x0, 1e-6)
    beste_ueberdeckung = 0.0
    kleinster_abstand = 1e9
    zeichen = 0
    for b in article.blocks:
        if b.page_index != img.page_index or b.kind == "caption":
            continue
        zeichen += b.char_count
        ueberdeckung = (min(b.x1, img.x1) - max(b.x0, img.x0)) / breite
        beste_ueberdeckung = max(beste_ueberdeckung, min(1.0, ueberdeckung))
        if b.y0 >= img.y1:
            abstand = b.y0 - img.y1          # Block steht unter dem Bild
        elif b.y1 <= img.y0:
            abstand = img.y0 - b.y1          # Block steht ueber dem Bild
        else:
            abstand = 0.0                    # Block laeuft neben dem Bild
        if ueberdeckung > 0.15:
            kleinster_abstand = min(kleinster_abstand, abstand)
    if beste_ueberdeckung <= 0 and kleinster_abstand > NEAR_GAP:
        return 0.0
    naehe = max(0.0, 1.0 - min(kleinster_abstand, NEAR_GAP) / NEAR_GAP)
    return beste_ueberdeckung * 1.0 + naehe * 0.8 + min(1.0, zeichen / 1500) * 0.2


def _attach_images(articles: list[AssembledArticle], images: list[SourceImage]) -> None:
    """Bilder ihren Artikeln zuordnen und in Lesereihenfolge ablegen."""
    for img in images:
        auf_seite = [
            a
            for a in articles
            if any(b.page_index == img.page_index for b in a.blocks)
        ]
        best, best_score = None, 0.0
        for a in auf_seite:
            score = _image_score(a, img)
            if score > best_score:
                best, best_score = a, score
        if best is None:
            # Keine Spaltenverwandtschaft: der Artikel, der die Seite traegt.
            gewichte = {}
            for a in auf_seite:
                gewichte[id(a)] = sum(
                    b.char_count for b in a.blocks if b.page_index == img.page_index
                )
            if auf_seite:
                best = max(auf_seite, key=lambda a: gewichte[id(a)])
        if best is None:
            # Ganzseitiges Bild ohne Text: der Artikel, ueber dessen Seiten es liegt.
            best = next((a for a in articles if img.page_index in a.pages), None)
        if best is not None and len(best.images) < MAX_IMAGES_PER_ARTICLE:
            best.images.append(img)

    for a in articles:
        a.images.sort(key=lambda i: (i.page_index, round(i.y0, 3), i.x0))


def _confidence(article: AssembledArticle) -> float:
    """Grober Hinweis fuer die Redaktion, wo sie zuerst hinschauen sollte."""
    score = 1.0
    body = sum(b.char_count for b in article.blocks if b.kind == "paragraph")
    if body < MIN_ARTICLE_CHARS:
        score -= 0.35
    if not article.blocks or article.blocks[0].kind != "heading":
        score -= 0.25
    if len(article.pages) > 6:
        score -= 0.15
    first = article.blocks[0].text if article.blocks else ""
    if first and first[:1].islower():
        score -= 0.2
    return max(0.05, round(score, 2))
