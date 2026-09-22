"""Aus kanonischen Bloecken Artikel bauen.

Kein "eine Seite gleich ein Artikel". Ein Artikel beginnt an einer Ueberschrift
und laeuft ueber Spalten und Seiten weiter, bis die naechste Ueberschrift
kommt. Zusaetzlich zaehlen Schriftgroessen, Satzfortsetzung und, falls
vorhanden, die Story-Zuordnung aus IDML.
"""

from __future__ import annotations

import re
from dataclasses import replace

from .model import AssembledArticle, SourceBlock, SourceImage, TocHint
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
    toc_hints: list[TocHint] | None = None,
) -> list[AssembledArticle]:
    """Bloecke in Lesereihenfolge zu Artikeln gruppieren."""
    usable = _merge_heading_runs([b for b in blocks if not b.drop])
    if toc_hints:
        grouped = _assemble_by_toc(usable, toc_hints)
        if grouped:
            _attach_images(grouped, images or [])
            return _finish(grouped)

    articles = _assemble_by_headings(usable)
    _attach_images(articles, images or [])
    return _finish(articles)


def _assemble_by_headings(blocks: list[SourceBlock]) -> list[AssembledArticle]:
    """Generische Gruppierung innerhalb eines frei waehlbaren Seitenbereichs."""
    articles: list[AssembledArticle] = []
    current: AssembledArticle | None = None
    prev_body: SourceBlock | None = None

    for block in blocks:
        if block.kind == "caption":
            # Bildunterschriften gehoeren nicht in den Fliesstext.
            continue

        # Eine Ueberschrift ohne ein einziges richtiges Wort taugt nicht als
        # Artikelanfang: Preisleisten und gesperrte Zierschrift von der
        # Titelseite haben sonst eigene Artikel eroeffnet.
        starts_new = block.kind == "heading" and is_meaningful(block.text)
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

    return _merge_small(articles)


def _finish(articles: list[AssembledArticle]) -> list[AssembledArticle]:
    for a in articles:
        body = "\n\n".join(b.text for b in a.blocks if b.kind == "paragraph")
        a.teaser = first_sentence(clean_text(body)) if body else None
        if not a.title:
            a.title = (body[:80] or "Ohne Titel").split("\n")[0]
        a.confidence = _confidence(a)
    return articles


def flow_text_blocks(blocks: list[SourceBlock]) -> list[SourceBlock]:
    """Kurze Satzzeilen eines mehrspaltigen Kastens zu Fliesstext verbinden.

    Die PDF-Textebene liefert bei Text, der um ein Bild herumlaeuft, teilweise
    jede Druckzeile als eigenen Block. Fuer Geometrie und Debugging bleiben die
    Originalbloecke erhalten. Nur die Artikelansicht bekommt hier je Seite
    einen lesbaren Absatz in Spaltenreihenfolge.
    """
    out: list[SourceBlock] = []
    pages = sorted({block.page_index for block in blocks})
    for page in pages:
        page_blocks = [block for block in blocks if block.page_index == page]
        # Bloecke aus dem Satz sind schon ganze Absaetze; die Zeilenheuristik
        # wuerde sie nur wieder zerlegen.
        if any(block.origin == "idml" for block in page_blocks):
            out.extend(page_blocks)
            continue
        paragraphs = [block for block in page_blocks if block.kind == "paragraph"]
        short_lines = [
            block
            for block in paragraphs
            if block.char_count < 90 and block.y1 - block.y0 < 0.04
        ]
        if len(short_lines) < 8 or len(short_lines) < len(paragraphs) * 0.7:
            out.extend(page_blocks)
            continue

        centers = sorted((block.x0 + block.x1) / 2 for block in paragraphs)
        gaps = [(right - left, (right + left) / 2) for left, right in zip(centers, centers[1:])]
        largest_gap, split = max(gaps, default=(0.0, 0.5))
        if largest_gap > 0.1:
            ordered = sorted(
                paragraphs,
                key=lambda block: (
                    0 if (block.x0 + block.x1) / 2 < split else 1,
                    block.y0,
                    block.x0,
                ),
            )
        else:
            ordered = sorted(paragraphs, key=lambda block: (block.y0, block.x0))

        text = ""
        previous: SourceBlock | None = None
        for block in ordered:
            if not text:
                text = block.text.strip()
            elif previous and previous.continues_word:
                text += block.text.lstrip()
            else:
                text += " " + block.text.strip()
            previous = block

        merged = replace(
            ordered[0],
            text=text,
            x0=min(block.x0 for block in paragraphs),
            y0=min(block.y0 for block in paragraphs),
            x1=max(block.x1 for block in paragraphs),
            y1=max(block.y1 for block in paragraphs),
            kind="paragraph",
            continues_word=False,
        )
        # Ueberschrift, Unterzeile und Zitate bleiben erhalten. Der neue
        # Fliesstext nimmt die Stelle der vielen einzelnen Druckzeilen ein.
        non_paragraphs = [block for block in page_blocks if block.kind != "paragraph"]
        out.extend(non_paragraphs)
        out.append(merged)
    return out


def _assemble_by_toc(
    blocks: list[SourceBlock], toc_hints: list[TocHint]
) -> list[AssembledArticle]:
    """Artikel anhand der redaktionellen Startseiten des Inhalts gruppieren.

    Das gedruckte Inhaltsverzeichnis ist fuer ein Magazin das staerkste Signal:
    ein Eintrag beginnt auf seiner Zielseite und laeuft bis zum naechsten
    Eintrag. Dadurch zerlegen Zwischenueberschriften oder Aufmacher auf den
    Folgeseiten einen langen Artikel nicht mehr in zufaellige Fragmente.
    """
    starts: list[TocHint] = []
    for hint in sorted(toc_hints, key=lambda h: (h.page_index, h.y0)):
        if starts and starts[-1].page_index == hint.page_index:
            if starts[-1].split_headings and hint.split_headings:
                # Zwei Rubrikeintraege auf derselben Seite, etwa "Nachrichten
                # aus Deutschland" und "Nachrichten aus aller Welt": die Seite
                # wird ohnehin an ihren Ueberschriften getrennt, ein zweiter
                # Anker aendert daran nichts.
                continue
            # Mehrere echte Artikel auf derselben Seite brauchen Geometrie aus
            # dem Satz. Ohne sie bleibt die generische Gruppierung sicherer.
            return []
        starts.append(hint)

    articles: list[AssembledArticle] = []
    # Text vor dem ersten Eintrag des Inhaltsverzeichnisses darf nicht
    # verschwinden, nur weil ihn das Verzeichnis nicht nennt. Er wird generisch
    # gruppiert, so wie ein Heft ohne Verzeichnis.
    leading = [block for block in blocks if block.page_index < starts[0].page_index]
    if leading:
        articles.extend(_assemble_by_headings(leading))
    for index, hint in enumerate(starts):
        end = starts[index + 1].page_index if index + 1 < len(starts) else 10**9
        article_blocks = [
            block for block in blocks if hint.page_index <= block.page_index < end
        ]
        if not article_blocks:
            continue
        # Das gedruckte Verzeichnis nennt nur die Hauptbeitraege. Stehen im
        # Bereich weitere Ueberschriften aus dem Satz, sind das eigene Artikel:
        # der Satz unterscheidet Ueberschrift und Zwischenueberschrift
        # zuverlaessig, anders als eine Messung an Schriftgroessen im PDF.
        weitere_ueberschriften = (
            sum(
                1
                for b in article_blocks
                if b.origin == "idml" and b.kind == "heading" and is_meaningful(b.text)
            )
            > 1
        )
        if hint.split_headings or weitere_ueberschriften:
            parts = _assemble_by_headings(article_blocks)
            # Beginnt die Rubrikseite ohne eigene Ueberschrift (Kalenderblatt,
            # Buchbesprechungen), heisst der erste Teil wie der Eintrag im
            # Inhalt statt wie seine erste Textzeile.
            if parts and parts[0].blocks and parts[0].blocks[0].kind != "heading":
                parts[0].title = hint.label
            articles.extend(parts)
        else:
            articles.append(AssembledArticle(title=hint.label, blocks=article_blocks))
    return articles


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


# Lange Titelstrecken laufen bei ZUERST! ueber zehn Seiten und tragen deutlich
# mehr als zwoelf redaktionelle Bilder. Die alte Grenze kappte genau diese
# Mehrseitenartikel; die Speicherung erfolgt ohnehin als einzelne Datensaetze.
MAX_IMAGES_PER_ARTICLE = 40
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
