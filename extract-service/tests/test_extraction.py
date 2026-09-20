"""Pruefungen fuer die Aufbereitung von Druckdateien.

Die Tests laufen gegen das echte Testheft, wenn es im Arbeitsverzeichnis liegt;
sonst gegen kleine erzeugte Fixtures.
"""

from __future__ import annotations

import io
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from extractor.article_assembler import assemble  # noqa: E402
from extractor.idml_extract import extract_idml_blocks  # noqa: E402
from extractor.model import SourceBlock  # noqa: E402
from extractor.pdf_extract import (  # noqa: E402
    extract_pdf_pages,
    mark_furniture,
    prepare_blocks,
)
from extractor.textutil import clean_text, glue_dropcap  # noqa: E402

HEFT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "hefte test",
    "zuerst 3-2026 innenteil.pdf",
)
UMSCHLAG = HEFT.replace("zuerst 3-2026 innenteil.pdf", "umschlag zuerst 3-2026.pdf")
has_heft = pytest.mark.skipif(not os.path.exists(HEFT), reason="Testheft fehlt")


def block(text: str, page: int = 0, y: float = 0.1, **kw) -> SourceBlock:
    return SourceBlock(
        page_index=page, text=text, x0=0.1, y0=y, x1=0.9, y1=y + 0.05, **kw
    )


def test_trennstrich_wird_nur_bei_umbruch_gezogen():
    assert clean_text("Sozialversiche-\nrung") == "Sozialversicherung"
    # Ein echtes Bindestrichwort bleibt stehen.
    assert clean_text("AfD-Anfrage") == "AfD-Anfrage"


def test_weicher_trennstrich_verschwindet():
    assert clean_text("Ton­ nen") == "Tonnen"


def test_initiale_wird_ans_wort_gesetzt():
    assert glue_dropcap("B ürgergeld steigt") == "Bürgergeld steigt"
    # Vorangestellte Seitenzahl faellt mit weg.
    assert glue_dropcap("4 D ie Lage") == "Die Lage"
    # Normale Saetze bleiben unberuehrt.
    assert glue_dropcap("Die Lage bleibt") == "Die Lage bleibt"


def test_kolumnentitel_und_slug_werden_aussortiert():
    blocks = [block("Deutsches Nachrichtenmagazin 3/2026", page=p, y=0.95) for p in range(8)]
    blocks.append(block("zuerst 3-2026.indd 12", page=3, y=0.98))
    blocks.append(block("Ein ganz normaler Absatz mit Inhalt.", page=3, y=0.4))
    mark_furniture(blocks, page_count=8)
    assert all(b.drop for b in blocks[:8])
    assert blocks[8].drop
    assert not blocks[9].drop


def test_artikel_beginnt_an_der_ueberschrift():
    blocks = [
        block("Erste Meldung", kind="heading", y=0.1),
        block("Text der ersten Meldung." * 12, y=0.2),
        block("Zweite Meldung", kind="heading", y=0.5),
        block("Text der zweiten Meldung." * 12, y=0.6),
    ]
    articles = assemble(blocks)
    assert [a.title for a in articles] == ["Erste Meldung", "Zweite Meldung"]


def test_idml_liest_stories_mit_absatzformat():
    idml = io.BytesIO()
    story = """<?xml version="1.0"?>
    <idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
      <Story Self="story1">
        <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Ueberschrift">
          <CharacterStyleRange><Content>Grosse Schlagzeile</Content></CharacterStyleRange>
        </ParagraphStyleRange>
        <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Fliesstext">
          <CharacterStyleRange><Content>Der eigentliche Text.</Content></CharacterStyleRange>
        </ParagraphStyleRange>
      </Story>
    </idPkg:Story>"""
    with zipfile.ZipFile(idml, "w") as zf:
        zf.writestr("Stories/Story_story1.xml", story)
    blocks = extract_idml_blocks(idml.getvalue())
    assert [b.kind for b in blocks] == ["heading", "paragraph"]
    assert blocks[0].story_id == "story1"
    assert blocks[1].style_name == "Fliesstext"


def test_idml_ignoriert_pfade_ausserhalb_des_archivs():
    idml = io.BytesIO()
    with zipfile.ZipFile(idml, "w") as zf:
        zf.writestr("Stories/../../boese.xml", "<x/>")
    # Kein Ausbruch, kein Fehler: der Eintrag wird schlicht uebergangen.
    assert extract_idml_blocks(idml.getvalue()) == []


@has_heft
def test_mehrspaltige_seite_wird_nicht_verzahnt():
    data = open(HEFT, "rb").read()
    blocks, images = extract_pdf_pages(data, [(2, 4)])
    ordered = prepare_blocks(blocks, images, 84)
    headings = [b.text for b in ordered if b.kind == "heading" and not b.drop]
    assert any("Abschiebungen in NRW" in h for h in headings)
    body = " ".join(b.text for b in ordered if b.kind == "paragraph" and not b.drop)
    # Zwei Spalten duerfen sich nicht im selben Satz mischen.
    assert "durchgeführt A S te Partei" not in body


@has_heft
def test_langer_artikel_laeuft_ueber_seiten():
    data = open(HEFT, "rb").read()
    blocks, images = extract_pdf_pages(data, [(i, i + 2) for i in range(4, 14)])
    ordered = prepare_blocks(blocks, images, 84)
    articles = assemble(ordered, images)
    laengster = max(articles, key=lambda a: sum(b.char_count for b in a.blocks))
    assert len(laengster.pages) >= 4
    text = " ".join(b.text for b in laengster.blocks if b.kind == "paragraph")
    assert len(text) > 8000


@has_heft
def test_seitenzahlen_stehen_nicht_im_text():
    data = open(HEFT, "rb").read()
    blocks, images = extract_pdf_pages(data, [(i, i + 2) for i in range(6)])
    ordered = prepare_blocks(blocks, images, 84)
    body = " ".join(b.text for b in ordered if b.kind == "paragraph" and not b.drop)
    assert "Deutsches Nachrichtenmagazin" not in body
    assert ".indd" not in body


@has_heft
def test_kanonische_reihenfolge_aus_zwei_quellen():
    """Umschlag in Bogenreihenfolge ergibt 84 Seiten, Titel zuerst."""
    import pypdfium2

    inner = pypdfium2.PdfDocument(open(HEFT, "rb").read())
    cover = pypdfium2.PdfDocument(open(UMSCHLAG, "rb").read())
    assert len(inner) == 80
    assert len(cover) == 4

    order = [("cover", 1), ("cover", 2)]
    order += [("inner", i) for i in range(len(inner))]
    order += [("cover", 3), ("cover", 0)]
    assert len(order) == 84
    assert order[0] == ("cover", 1)
    assert order[-1] == ("cover", 0)


def test_llm_gruppierung_ist_standardmaessig_aus():
    from extractor import llm

    os.environ.pop("EXTRACT_USE_LLM", None)
    assert llm.enabled() is False
