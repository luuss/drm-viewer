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

import render  # noqa: E402
from extractor.article_assembler import assemble, flow_text_blocks  # noqa: E402
from extractor.idml_extract import (  # noqa: E402
    extract_idml_blocks,
    extract_idml_image_frames,
    frames_to_images,
)
from extractor.image_regions import (  # noqa: E402
    RawImage,
    area,
    drop_repeating,
    overlap_area,
    read_raw_images,
    select_regions,
    text_spread,
)
from extractor.page_geometry import (  # noqa: E402
    half_of_box,
    rect_on_visible_page,
    visible_page_box,
)
from extractor.model import LayoutLine, SourceBlock, SourceImage, TocHint  # noqa: E402
from extractor.pdf_extract import (  # noqa: E402
    _split_line_at_gaps,
    _words_on_visible_page,
    _words_to_lines,
    attach_captions,
    extract_pdf_pages,
    mark_furniture,
    prepare_blocks,
)
from extractor.textutil import clean_text, glue_dropcap  # noqa: E402
from extractor.publication_profiles import (  # noqa: E402
    apply_profile,
    extract_dmz_toc,
    extract_zuerst_toc,
)
from tests import idml_fixture  # noqa: E402

HEFT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "hefte test",
    "zuerst 3-2026 innenteil.pdf",
)
UMSCHLAG = HEFT.replace("zuerst 3-2026 innenteil.pdf", "umschlag zuerst 3-2026.pdf")
has_heft = pytest.mark.skipif(not os.path.exists(HEFT), reason="Testheft fehlt")

# Zweites Musterheft: DMZ 170, A4, Umschlag als zwei Doppelseiten.
DMZ_HEFT = os.path.join(os.path.dirname(HEFT), "dmz 170 innenteil.pdf")
DMZ_UMSCHLAG = os.path.join(os.path.dirname(HEFT), "umschlag dmz 170.pdf")
has_dmz = pytest.mark.skipif(not os.path.exists(DMZ_HEFT), reason="DMZ-Testheft fehlt")


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


def test_bindestrichwort_ueberlebt_den_umbruch():
    # Nach dem Strich steht ein Grossbuchstabe: das Wort heisst wirklich so.
    assert (
        clean_text("Zwangs-\nNacktuntersuchungen")
        == "Zwangs-Nacktuntersuchungen"
    )
    assert clean_text("Gold-\nRückholung") == "Gold-Rückholung"


def test_weicher_trennstrich_vor_grossbuchstabe_wird_bindestrich():
    # InDesign setzt in Bindestrichwoertern einen bedingten Trennstrich, damit
    # dort umbrochen werden darf. Er gehoert trotzdem ins Wort.
    assert clean_text("Nordrhein\u00adWestfalen") == "Nordrhein-Westfalen"
    assert clean_text("Mercosur\u00adAbkommen") == "Mercosur-Abkommen"
    # Echte Silbentrennung endet klein und verschwindet weiterhin.
    assert clean_text("demogra\u00adphischen") == "demographischen"


def test_zeile_ueber_zwei_spalten_bleibt_ganz():
    """Eine Ueberschrift ueber mehrere Spalten darf nicht zerschnitten werden."""
    woerter = [
        {"text": "Sozialabgaben", "x0": 87.0, "x1": 199.0, "top": 76.0,
         "bottom": 92.0, "size": 16.0, "fontname": "Arial-BoldMT"},
        {"text": "bald", "x0": 204.0, "x1": 236.0, "top": 76.0,
         "bottom": 92.0, "size": 16.0, "fontname": "Arial-BoldMT"},
        {"text": "über", "x0": 241.0, "x1": 276.0, "top": 76.0,
         "bottom": 92.0, "size": 16.0, "fontname": "Arial-BoldMT"},
        {"text": "50", "x0": 280.0, "x1": 298.0, "top": 76.0,
         "bottom": 92.0, "size": 16.0, "fontname": "Arial-BoldMT"},
        {"text": "Prozent?", "x0": 302.0, "x1": 371.0, "top": 76.0,
         "bottom": 92.0, "size": 16.0, "fontname": "Arial-BoldMT"},
    ]
    [zeile] = _words_to_lines(woerter)
    stuecke = _split_line_at_gaps(zeile)
    assert len(stuecke) == 1
    assert stuecke[0]["text"] == "Sozialabgaben bald über 50 Prozent?"


def test_nebeneinanderliegende_spalten_werden_getrennt():
    """Zwei Spalten auf gleicher Hoehe duerfen nicht verzahnt werden."""
    woerter = [
        {"text": "linke", "x0": 52.0, "x1": 90.0, "top": 100.0, "bottom": 111.0,
         "size": 10.8, "fontname": "MinionPro"},
        {"text": "Spalte", "x0": 93.0, "x1": 140.0, "top": 100.0, "bottom": 111.0,
         "size": 10.8, "fontname": "MinionPro"},
        {"text": "rechte", "x0": 427.0, "x1": 470.0, "top": 100.0, "bottom": 111.0,
         "size": 10.8, "fontname": "MinionPro"},
        {"text": "Spalte", "x0": 473.0, "x1": 520.0, "top": 100.0, "bottom": 111.0,
         "size": 10.8, "fontname": "MinionPro"},
    ]
    [zeile] = _words_to_lines(woerter)
    stuecke = _split_line_at_gaps(zeile)
    assert [s["text"] for s in stuecke] == ["linke Spalte", "rechte Spalte"]


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


def test_inhaltsanker_halten_mehrseitigen_artikel_zusammen():
    blocks = [
        block("Grosser Titel", page=7, kind="heading"),
        block("Anfang. " * 80, page=7, y=0.2),
        block("Zwischenruf", page=9, kind="heading"),
        block("Fortsetzung. " * 80, page=9, y=0.2),
        block("Naechster Artikel", page=17, kind="heading"),
        block("Neuer Text. " * 40, page=17, y=0.2),
    ]
    hints = [
        TocHint("Vergiftete Nachbarschaft", 7, 3, 0.05, 0.1, 0.3, 0.14),
        TocHint("Slawischer Landraub", 17, 3, 0.05, 0.2, 0.3, 0.24),
    ]
    image = bild(page=9)
    articles = assemble(blocks, [image], toc_hints=hints)

    assert [a.title for a in articles] == [
        "Vergiftete Nachbarschaft",
        "Slawischer Landraub",
    ]
    assert articles[0].pages == [7, 9]
    assert articles[0].images == [image]


def test_rubrikhint_laesst_einzelmeldungen_getrennt():
    blocks = [
        block("Erste Meldung", page=4, kind="heading", y=0.1),
        block("Text der ersten Meldung. " * 20, page=4, y=0.2),
        block("Zweite Meldung", page=4, kind="heading", y=0.5),
        block("Text der zweiten Meldung. " * 20, page=4, y=0.6),
        block("Grosser Folgeartikel", page=7, kind="heading", y=0.1),
        block("Text des Folgeartikels. " * 20, page=7, y=0.2),
    ]
    hints = [
        TocHint(
            "Politikmeldungen", 4, 3, 0.05, 0.1, 0.3, 0.14,
            split_headings=True,
        ),
        TocHint("Grosser Folgeartikel", 7, 3, 0.05, 0.2, 0.3, 0.24),
    ]

    articles = assemble(blocks, toc_hints=hints)

    assert [a.title for a in articles] == [
        "Erste Meldung",
        "Zweite Meldung",
        "Grosser Folgeartikel",
    ]


def test_zuerst_profil_entfernt_umschlag_und_inhaltsseite():
    pages = [
        {"index": 0, "role": "front_cover", "printedLabel": "U1"},
        {"index": 1, "role": "inside_front", "printedLabel": "U2"},
        {"index": 2, "role": "content", "printedLabel": "3"},
        {"index": 3, "role": "content", "printedLabel": "4"},
        {"index": 4, "role": "content", "printedLabel": "5"},
    ]
    blocks = [block("Umschlag", page=0), block("Editorial", page=2),
              block("Inhalt", page=3), block("Politik", page=4)]
    images = [bild(page=0), bild(page=2), bild(page=3), bild(page=4)]
    kept_blocks, kept_images, _toc = apply_profile(blocks, images, pages, "zuerst")

    assert [b.page_index for b in kept_blocks] == [2, 4]
    assert [i.page_index for i in kept_images] == [2, 4]


def test_andere_publikation_bleibt_unveraendert():
    pages = [{"index": 0, "role": "content", "printedLabel": "1"}]
    blocks = [block("Im Vorfeld von Bologna")]
    images = [bild()]
    kept_blocks, kept_images, toc = apply_profile(blocks, images, pages, "weltkrieg")
    assert kept_blocks == blocks
    assert kept_images == images
    assert toc == []


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
def test_zuerst_seite_fuenf_trennt_fuenf_meldungen_mit_bildern():
    data = open(HEFT, "rb").read()
    # Gedruckte Seite 4 (TOC) bis Seite 14 des grossen Titelartikels.
    blocks, images = extract_pdf_pages(data, [(i, i + 2) for i in range(1, 12)])
    pages = [
        {"index": 0, "role": "front_cover", "printedLabel": "U1"},
        {"index": 1, "role": "inside_front", "printedLabel": "U2"},
        *[
            {"index": i + 2, "role": "content", "printedLabel": str(i + 3)}
            for i in range(80)
        ],
    ]
    blocks, images, hints = apply_profile(blocks, images, pages, "zuerst")
    articles = assemble(
        prepare_blocks(blocks, images, 84), images, toc_hints=hints
    )
    page_five = [article for article in articles if 4 in article.pages]

    assert [article.title for article in page_five] == [
        "Abschiebungen in NRW: Chronik des Scheiterns",
        "Arbeitsagentur bleibt auf Milliardenschulden sitzen",
        "50 Prozent der Russen sehen Deutschland als „Feind“",
        "„Team Freiheit“ scheitert: Nur 82 statt 2.080 Unterschriften",
        "Grüne machen AfD-Verbot zur Koalitionsbedingung",
    ]
    assert [len(article.images) for article in page_five] == [1, 1, 1, 1, 1]
    assert all(
        block.text != "POLITIK"
        for article in page_five
        for block in article.blocks
    )
    russia = next(
        article for article in page_five if article.title.startswith("50 Prozent")
    )
    flowed = flow_text_blocks(russia.blocks)
    paragraphs = [block for block in flowed if block.kind == "paragraph"]
    assert len(paragraphs) == 1
    assert "Stimmungsbild" in paragraphs[0].text
    assert "Sacharow-Gesellschaft" in paragraphs[0].text

    # Die feste Karikatur unten auf gedruckter Seite 6 bleibt nur im
    # originalgetreuen Seitenmodus; die drei redaktionellen Bilder bleiben.
    page_six_images = [image for image in images if image.page_index == 5]
    assert len(page_six_images) == 3
    assert all(image.y0 < 0.59 for image in page_six_images)
    page_six = [article for article in articles if 5 in article.pages]
    assert page_six
    assert all(not article.title.startswith("POLITIK ") for article in page_six)

    # Seiten 8–14 wurden einzeln gegen den Satz kontrolliert. Die Karte auf
    # Seite 9 ist Vektorgrafik und braucht den Profilrahmen; alle zehn Bilder
    # stehen danach seitenweise und innerhalb der Seite von oben nach unten.
    title_story = next(
        article for article in articles if article.title == "Vergiftete Nachbarschaft"
    )
    checked = [
        image for image in title_story.images if 7 <= image.page_index <= 13
    ]
    assert [image.page_index for image in checked] == [
        7, 8, 8, 9, 9, 10, 11, 12, 12, 13, 13
    ]
    for page_index in range(7, 14):
        ys = [image.y0 for image in checked if image.page_index == page_index]
        assert ys == sorted(ys)
    page_nine = [image for image in checked if image.page_index == 8]
    assert len(page_nine) == 2
    assert page_nine[1].caption == "Deutsche Gebietsverluste 1919/1945"


@has_heft
def test_zuerst_inhaltsverzeichnis_liefert_ziele_und_flaechen():
    data = open(HEFT, "rb").read()
    blocks, _images = extract_pdf_pages(data, [(1, 3)])
    pages = [
        {"index": 0, "role": "front_cover", "printedLabel": "U1"},
        {"index": 1, "role": "inside_front", "printedLabel": "U2"},
        *[
            {"index": i + 2, "role": "content", "printedLabel": str(i + 3)}
            for i in range(80)
        ],
    ]
    hints = extract_zuerst_toc(blocks, pages, "zuerst")
    by_title = {hint.label: hint for hint in hints}

    assert len(hints) >= 35
    assert by_title["Editorial"].page_index == 2
    assert by_title["Politikmeldungen"].page_index == 4
    assert by_title["Politikmeldungen"].split_headings is True
    assert by_title["Vergiftete Nachbarschaft"].page_index == 7
    assert by_title["Migrantifa gegen Connewitz"].page_index == 34
    assert all(hint.toc_page_index == 3 for hint in hints)
    assert all(hint.x1 > hint.x0 and hint.y1 > hint.y0 for hint in hints)


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


# --- Bildbereiche ----------------------------------------------------------


def wort(x0: float, y0: float, breite: float = 0.06, hoehe: float = 0.012):
    return (x0, y0, x0 + breite, y0 + hoehe)


def satzspiegel(x0: float, y0: float, x1: float, y1: float, zeilen: int = 14):
    """Wortrechtecke, die eine Textspalte nachbilden."""
    worte = []
    schritt = (y1 - y0) / zeilen
    for i in range(zeilen):
        x = x0
        while x < x1 - 0.02:
            worte.append((x, y0 + i * schritt, min(x + 0.05, x1), y0 + i * schritt + schritt * 0.6))
            x += 0.06
    return worte


def roh(x0, y0, x1, y1, **kw):
    return RawImage((x0, y0, x1, y1), **kw)


def test_ganzseitiger_hintergrund_wird_verworfen():
    """Das Titelbild traegt den ganzen Seitentext — als Artikelbild wertlos."""
    trim = (0.03, 0.03, 0.97, 0.97)
    worte = satzspiegel(0.1, 0.1, 0.9, 0.9)
    assert select_regions([roh(0.02, 0.02, 0.98, 0.98)], worte, trim) == []


def test_ganzseitiges_bild_ohne_text_bleibt():
    """Eine Aufmacherseite ohne Satz ist ein gutes Artikelbild."""
    trim = (0.03, 0.03, 0.97, 0.97)
    behalten = select_regions([roh(0.02, 0.02, 0.98, 0.98)], [], trim)
    assert len(behalten) == 1
    # Auf das Netzformat zurechtgeschnitten, nicht auf den Anschnitt.
    assert behalten[0] == pytest.approx(trim)


def test_maske_ueber_der_textspalte_wird_verworfen():
    trim = (0.03, 0.03, 0.97, 0.97)
    worte = satzspiegel(0.08, 0.2, 0.45, 0.8)
    assert select_regions([roh(0.07, 0.19, 0.46, 0.81)], worte, trim) == []


def test_foto_mit_unterschrift_im_bild_bleibt():
    """Die Unterschrift steht in einer Ecke, nicht ueber die ganze Flaeche."""
    trim = (0.03, 0.03, 0.97, 0.97)
    worte = [wort(0.12 + 0.07 * i, 0.55) for i in range(4)]
    worte += [wort(0.12 + 0.07 * i, 0.58) for i in range(4)]
    behalten = select_regions([roh(0.08, 0.2, 0.45, 0.62)], worte, trim)
    assert len(behalten) == 1


def test_streifen_und_schnipsel_fallen_weg():
    trim = (0.0, 0.0, 1.0, 1.0)
    roh_bilder = [
        roh(0.1, 0.1, 0.9, 0.13),    # Zierstreifen
        roh(0.1, 0.1, 0.13, 0.13),   # Schnipsel
        roh(0.1, 0.1, 0.5, 0.5, stencil=True),   # Signet als 1-Bit-Maske
        roh(0.1, 0.6, 0.5, 0.9, source_px=40),   # Symbol in Briefmarkengroesse
    ]
    assert select_regions(roh_bilder, [], trim) == []


def test_gestapelte_lagen_werden_zusammengefasst():
    """Bild und Weichzeichnermaske liegen uebereinander und sind ein Bild."""
    trim = (0.0, 0.0, 1.0, 1.0)
    behalten = select_regions(
        [roh(0.1, 0.1, 0.5, 0.5), roh(0.12, 0.12, 0.52, 0.48)], [], trim
    )
    assert behalten == [(0.1, 0.1, 0.52, 0.5)]


def test_zwei_fotos_um_eine_textspalte_bleiben_getrennt():
    """Ohne Ueberlappung wird nichts zusammengefasst."""
    trim = (0.0, 0.0, 1.0, 1.0)
    worte = satzspiegel(0.42, 0.1, 0.58, 0.9)
    behalten = select_regions(
        [roh(0.05, 0.1, 0.40, 0.9), roh(0.60, 0.1, 0.95, 0.9)], worte, trim
    )
    assert len(behalten) == 2


def test_seitenschmuck_auf_vielen_seiten_faellt_weg():
    """Ein Rubrikbalken steht auf jeder Seite an derselben Stelle."""
    balken = (0.08, 0.06, 0.92, 0.09)
    # Echte Fotos stehen nie zweimal exakt gleich.
    seiten = {i: [balken, (0.1, 0.3 + i * 0.01, 0.6, 0.7)] for i in range(20)}
    bereinigt = drop_repeating(seiten, page_count=20)
    assert all(balken not in rects for rects in bereinigt.values())
    assert all(len(rects) == 1 for rects in bereinigt.values())


def test_textstreuung_trennt_unterschrift_von_spalte():
    rect = (0.1, 0.1, 0.5, 0.5)
    ecke = [wort(0.12 + 0.07 * i, 0.44) for i in range(4)]
    assert text_spread(rect, ecke) < 0.3
    assert text_spread(rect, satzspiegel(0.11, 0.11, 0.49, 0.49)) > 0.9


# --- Bildunterschriften ----------------------------------------------------


def bild(page: int = 0, x0: float = 0.1, y0: float = 0.1,
         x1: float = 0.5, y1: float = 0.4) -> SourceImage:
    return SourceImage(page_index=page, x0=x0, y0=y0, x1=x1, y1=y1)


def test_unterschrift_gehoert_zum_bild_darueber():
    b = bild()
    c = SourceBlock(page_index=0, text="Der Kanzler bei seinem Besuch.",
                    x0=0.1, y0=0.41, x1=0.5, y1=0.44, kind="caption")
    attach_captions([b], [c])
    assert b.caption == "Der Kanzler bei seinem Besuch."


def test_unterschrift_aus_der_nachbarspalte_zaehlt_nicht():
    b = bild()
    c = SourceBlock(page_index=0, text="Gehoert zum anderen Bild.",
                    x0=0.6, y0=0.41, x1=0.95, y1=0.44, kind="caption")
    attach_captions([b], [c])
    assert b.caption is None


def test_unterschrift_weit_darunter_zaehlt_nicht():
    b = bild()
    c = SourceBlock(page_index=0, text="Steht viel weiter unten.",
                    x0=0.1, y0=0.7, x1=0.5, y1=0.73, kind="caption")
    attach_captions([b], [c])
    assert b.caption is None


def test_unterschrift_wird_nur_einmal_vergeben():
    """Das naeher stehende Bild bekommt sie."""
    oben = bild(y0=0.05, y1=0.20)
    unten = bild(y0=0.25, y1=0.40)
    c = SourceBlock(page_index=0, text="Nur eine Unterschrift.",
                    x0=0.1, y0=0.42, x1=0.5, y1=0.45, kind="caption")
    attach_captions([oben, unten], [c])
    assert unten.caption == "Nur eine Unterschrift."
    assert oben.caption is None


def test_fotonachweis_wird_nicht_zur_unterschrift():
    b = bild()
    c = SourceBlock(page_index=0, text="Foto: dpa", x0=0.1, y0=0.41,
                    x1=0.5, y1=0.44, kind="caption")
    attach_captions([b], [c])
    assert b.caption is None


# --- Zuordnung Bild zu Artikel --------------------------------------------


def test_bild_geht_an_den_artikel_in_derselben_spalte():
    """Der raeumlich naechste Block ist nicht immer der richtige Artikel.

    Links steht ein langer Artikel mit einem Bild darunter, rechts beginnt ein
    zweiter. Dessen Ueberschrift sitzt naeher an der Bildmitte als der linke
    Fliesstext — nach Mittenabstand gewinnt der falsche.
    """
    links = SourceBlock(page_index=0, text="Der linke Artikel. " * 30,
                        x0=0.08, y0=0.10, x1=0.45, y1=0.55, kind="paragraph")
    links_kopf = SourceBlock(page_index=0, text="Linke Ueberschrift",
                             x0=0.08, y0=0.05, x1=0.45, y1=0.09, kind="heading",
                             max_size=20, size=20)
    rechts_kopf = SourceBlock(page_index=0, text="Rechte Ueberschrift",
                              x0=0.55, y0=0.60, x1=0.92, y1=0.64, kind="heading",
                              max_size=20, size=20)
    rechts = SourceBlock(page_index=0, text="Der rechte Artikel. " * 30,
                         x0=0.55, y0=0.65, x1=0.92, y1=0.95, kind="paragraph")
    img = bild(x0=0.08, y0=0.58, x1=0.45, y1=0.92)

    artikel = assemble([links_kopf, links, rechts_kopf, rechts], [img])
    treffer = [a for a in artikel if a.images]
    assert len(treffer) == 1
    assert treffer[0].title == "Linke Ueberschrift"


def test_bilder_stehen_in_lesereihenfolge():
    kopf = SourceBlock(page_index=0, text="Eine Ueberschrift", x0=0.08, y0=0.05,
                       x1=0.92, y1=0.09, kind="heading", max_size=20, size=20)
    text = SourceBlock(page_index=0, text="Viel Text. " * 40, x0=0.08, y0=0.10,
                       x1=0.92, y1=0.30, kind="paragraph")
    spaet = bild(x0=0.08, y0=0.70, x1=0.45, y1=0.90)
    frueh = bild(x0=0.08, y0=0.35, x1=0.45, y1=0.60)
    artikel = assemble([kopf, text], [spaet, frueh])
    assert [round(i.y0, 2) for i in artikel[0].images] == [0.35, 0.70]


def test_mehrseitenartikel_verliert_nicht_nach_zwoelf_bildern_den_rest():
    kopf = SourceBlock(page_index=0, text="Lange Titelstrecke", x0=0.08, y0=0.05,
                       x1=0.92, y1=0.09, kind="heading", max_size=20, size=20)
    text = SourceBlock(page_index=0, text="Viel Text. " * 80, x0=0.08, y0=0.10,
                       x1=0.92, y1=0.90, kind="paragraph")
    bilder = [bild(x0=0.1, y0=0.12 + i * 0.01, x1=0.4, y1=0.2 + i * 0.01) for i in range(18)]
    [artikel] = assemble([kopf, text], bilder)
    assert len(artikel.images) == 18


# --- Weisser Rand im Rendering --------------------------------------------


def _jpeg(image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def _pdf_with_trimbox() -> bytes:
    import pypdfium2

    document = pypdfium2.PdfDocument.new()
    page = document.new_page(220, 140)
    page.set_trimbox(10, 20, 210, 120)
    output = io.BytesIO()
    document.save(output)
    document.close()
    return output.getvalue()


def test_seitenrendering_verwendet_die_trimbox():
    from PIL import Image

    jpeg, width, height = render.render_page(_pdf_with_trimbox(), 0, width_px=400)
    image = Image.open(io.BytesIO(jpeg))
    assert (width, height) == (400, 200)
    assert image.size == (400, 200)


def test_pdf_rechtecke_werden_auf_die_trimbox_umgerechnet():
    visible = (10.0, 20.0, 210.0, 120.0)
    assert rect_on_visible_page((30.0, 40.0, 110.0, 100.0), visible) == pytest.approx(
        (0.1, 0.2, 0.5, 0.8)
    )


def test_textkoordinaten_werden_auf_die_trimbox_umgerechnet():
    from types import SimpleNamespace

    page = SimpleNamespace(
        trimbox=(10.0, 20.0, 210.0, 120.0),
        cropbox=(0.0, 0.0, 220.0, 140.0),
        mediabox=(0.0, 0.0, 220.0, 140.0),
        bbox=(0.0, 0.0, 220.0, 140.0),
        width=220.0,
        height=140.0,
    )
    words, width, height = _words_on_visible_page(
        page,
        [
            {"text": "sichtbar", "x0": 30.0, "x1": 110.0, "top": 40.0, "bottom": 100.0},
            {"text": "Druckmarke", "x0": 0.0, "x1": 5.0, "top": 5.0, "bottom": 10.0},
        ],
    )
    assert (width, height) == (200.0, 100.0)
    assert len(words) == 1
    assert (words[0]["x0"], words[0]["top"], words[0]["x1"], words[0]["bottom"]) == (
        20.0,
        20.0,
        100.0,
        80.0,
    )


def test_weisser_rand_wird_nachgemessen_und_abgeschnitten():
    """Der Beschnittpfad ist oft keine Rechteckform; sein Rechteck traegt Papier."""
    from PIL import Image

    seite = Image.new("RGB", (400, 400), (255, 255, 255))
    seite.paste(Image.new("RGB", (200, 200), (30, 90, 150)), (100, 100))
    aus = render.crop_region(_jpeg(seite), 0.0, 0.0, 1.0, 1.0, trim_blank=True)
    beschnitten = Image.open(io.BytesIO(aus))
    assert 170 <= beschnitten.width <= 230
    assert 170 <= beschnitten.height <= 230


def test_helles_foto_wird_nicht_zerlegt():
    """Ein Bild mit hellem, aber nicht einfarbigem Rand bleibt ganz."""
    from PIL import Image

    bildchen = Image.new("RGB", (300, 300))
    pixel = bildchen.load()
    for y in range(300):
        for x in range(300):
            pixel[x, y] = (200 + (x % 40), 210 + (y % 30), 220)
    voll = render.crop_region(_jpeg(bildchen), 0.0, 0.0, 1.0, 1.0, trim_blank=True)
    assert Image.open(io.BytesIO(voll)).width == 300


# --- IDML-Bildrahmen -------------------------------------------------------


def test_idml_liefert_bildrahmen_mit_geometrie():
    frames = extract_idml_image_frames(idml_fixture.bauen())
    # Drei Rahmen ueber drei Seiten, der vierte ist zu klein und faellt erst
    # beim Umrechnen weg.
    assert [f.page_number for f in frames] == [0, 1, 2, 2]
    assert [f.link for f in frames] == ["titel.jpg", "links.jpg", "rechts.jpg", "winzig.jpg"]
    titel = frames[0]
    # Rahmen 50..300 pt auf einer 595,276 pt breiten Seite.
    assert titel.x0 == pytest.approx(50 / 595.276, abs=0.002)
    assert titel.x1 == pytest.approx(300 / 595.276, abs=0.002)
    assert titel.y0 == pytest.approx(100 / 841.89, abs=0.002)
    assert titel.y1 == pytest.approx(400 / 841.89, abs=0.002)


def test_idml_ordnet_die_doppelseite_richtig_zu():
    """Auf einem Bogen liegen zwei Seiten; jeder Rahmen gehoert zu genau einer."""
    frames = extract_idml_image_frames(idml_fixture.bauen())
    zweite = [f for f in frames if f.page_number == 1]
    dritte = [f for f in frames if f.page_number == 2]
    assert [f.link for f in zweite] == ["links.jpg"]
    assert [f.link for f in dritte] == ["rechts.jpg", "winzig.jpg"]


def test_idml_rahmen_landen_in_der_trimbox_der_pdfseite():
    """Der Satz kennt kein Anschnittmass — das PDF bringt es mit."""
    frames = extract_idml_image_frames(idml_fixture.bauen())
    trim = (0.04, 0.03, 0.96, 0.97)
    images = frames_to_images(frames, [(0, 7), (1, 8), (2, 9)], {7: trim, 8: trim, 9: trim})
    assert [i.page_index for i in images] == [7, 8, 9]
    titel = images[0]
    assert titel.x0 == pytest.approx(0.04 + (50 / 595.276) * 0.92, abs=0.003)
    # Der winzige Rahmen ist kein Bild.
    assert len(images) == 3


def test_idml_ohne_bildrahmen_liefert_nichts():
    leer = io.BytesIO()
    with zipfile.ZipFile(leer, "w") as zf:
        zf.writestr("designmap.xml", "<Document/>")
    assert extract_idml_image_frames(leer.getvalue()) == []


# --- Am echten Heft --------------------------------------------------------


@has_heft
def test_heftanfang_liefert_keine_hintergruende_und_keine_dubletten():
    """Am Heftanfang war es am schlechtesten: Titel und U2 sind ganzseitig."""
    cover = open(UMSCHLAG, "rb").read()
    inner = open(HEFT, "rb").read()
    _b1, bilder = extract_pdf_pages(cover, [(1, 0), (2, 1)])
    _b2, innen = extract_pdf_pages(inner, [(i, i + 2) for i in range(8)])
    bilder += innen
    for img in bilder:
        flaeche = (img.x1 - img.x0) * (img.y1 - img.y0)
        assert flaeche < 0.8, f"Vollseiten-Hintergrund auf Seite {img.page_index}"
        assert flaeche > 0.009, f"Schnipsel auf Seite {img.page_index}"
    je_seite = {}
    for img in bilder:
        je_seite.setdefault(img.page_index, []).append(img)
    for seite, gruppe in je_seite.items():
        for i, a in enumerate(gruppe):
            for b in gruppe[i + 1:]:
                ra = (a.x0, a.y0, a.x1, a.y1)
                rb = (b.x0, b.y0, b.x1, b.y1)
                schnitt = overlap_area(ra, rb)
                vereinigung = area(ra) + area(rb) - schnitt
                assert schnitt / vereinigung < 0.5, f"Dublette auf Seite {seite}"


@has_heft
def test_kein_ausschnitt_deckt_den_satzspiegel_ab():
    """Kein Bildbereich darf ueber dem Satz liegen.

    Gemessen wird an den Wortrechtecken, nicht an den Blockrahmen: ein kleines
    Portraet mit Textumfluss steckt zwangslaeufig im Rahmen seines Absatzes,
    liegt aber nicht auf den Buchstaben.
    """
    import pdfplumber

    data = open(HEFT, "rb").read()
    karte = [(i, i + 2) for i in range(20)]
    _blocks, bilder = extract_pdf_pages(data, karte)

    # Gemessen wird am Fliesstext in Grundschriftgroesse. Kartenbeschriftung
    # und Anzeigensatz sind kleiner; sie duerfen im Bild stehen.
    from collections import Counter

    gezaehlt: Counter = Counter()
    roh = {}
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for quelle, kanonisch in karte:
            p = pdf.pages[quelle]
            seite = [
                w
                for w in p.extract_words(extra_attrs=["size"])
                if float(w.get("size", 0) or 0) >= 4.5
            ]
            roh[kanonisch] = (seite, p.width, p.height)
            for w in seite:
                gezaehlt[round(float(w["size"]), 1)] += len(w["text"])
    grund = gezaehlt.most_common(1)[0][0]
    worte = {
        k: [
            (w["x0"] / breite, w["top"] / hoehe, w["x1"] / breite, w["bottom"] / hoehe)
            for w in seite
            if abs(float(w["size"]) - grund) < grund * 0.15
        ]
        for k, (seite, breite, hoehe) in roh.items()
    }

    for img in bilder:
        rect = (img.x0, img.y0, img.x1, img.y1)
        seite = worte.get(img.page_index, [])
        dichte = sum(overlap_area(rect, w) for w in seite) / max(area(rect), 1e-6)
        if dichte > 0.07:
            assert text_spread(rect, seite) <= 0.45, (
                f"Seite {img.page_index}: Ausschnitt liegt auf dem Satz"
            )


@has_heft
def test_beschnittpfad_verkleinert_den_ausschnitt():
    """Auf Seite 5 steckt ein freigestelltes Bild in einem Ausschneidepfad."""
    data = open(HEFT, "rb").read()
    roh_bilder, _trims = read_raw_images(data, [(3, 5)])
    passbild = [
        r for r in roh_bilder[5]
        if r.rect[0] > 0.65 and r.rect[1] < 0.3 and r.rect[2] - r.rect[0] > 0.15
    ]
    assert passbild, "Bild im Ausschneidepfad nicht gefunden"
    # Ohne Pfad reicht die Platzierung bis weit in die Textspalte hinein.
    assert passbild[0].rect[0] > 0.70


# --- Halbe Quellseiten (Umschlag als Doppelseite) ---------------------------


def test_halbe_seite_ist_die_haelfte_des_netzformats():
    box = (20.0, 10.0, 1220.0, 850.0)
    assert half_of_box(box, None) == box
    assert half_of_box(box, "left") == (20.0, 10.0, 620.0, 850.0)
    assert half_of_box(box, "right") == (620.0, 10.0, 1220.0, 850.0)
    with pytest.raises(ValueError):
        half_of_box(box, "oben")


def test_sichtbare_seite_kennt_ihre_haelfte():
    class Bogen:
        def get_width(self):
            return 1240.0

        def get_height(self):
            return 890.0

        def get_trimbox(self):
            return (20.0, 20.0, 1220.0, 870.0)

    assert visible_page_box(Bogen()) == (20.0, 20.0, 1220.0, 870.0)
    assert visible_page_box(Bogen(), "right") == (620.0, 20.0, 1220.0, 870.0)
    assert visible_page_box(Bogen(), "left") == (20.0, 20.0, 620.0, 870.0)


def test_woerter_der_anderen_haelfte_fallen_weg():
    class Bogen:
        trimbox = (0.0, 0.0, 1000.0, 800.0)
        cropbox = mediabox = bbox = trimbox
        width, height = 1000.0, 800.0

    woerter = [
        {"text": "links", "x0": 100.0, "x1": 160.0, "top": 50.0, "bottom": 60.0},
        {"text": "rechts", "x0": 600.0, "x1": 660.0, "top": 50.0, "bottom": 60.0},
    ]
    sichtbar, breite, hoehe = _words_on_visible_page(Bogen(), woerter, "right")
    assert [w["text"] for w in sichtbar] == ["rechts"]
    assert (breite, hoehe) == (500.0, 800.0)
    # Die Koordinaten beziehen sich auf die Haelfte, nicht auf den Bogen.
    assert sichtbar[0]["x0"] == 100.0
    ganz, breite, _hoehe = _words_on_visible_page(Bogen(), woerter)
    assert [w["text"] for w in ganz] == ["links", "rechts"]
    assert breite == 1000.0


# --- DMZ-Profil --------------------------------------------------------------

def test_dmz_zeitgeschichte_hat_ein_eigenes_profil():
    from extractor.publication_profiles import profile_for

    assert profile_for("dmz") == "dmz"
    assert profile_for("dmz-170") == "dmz"
    assert profile_for("dmz-zeitgeschichte") == "dmz-zeitgeschichte"
    assert profile_for("schwertertraeger") is None


DMZ_PAGES = [
    {"index": 0, "role": "front_cover", "printedLabel": "U1"},
    {"index": 1, "role": "inside_front", "printedLabel": "U2"},
    *[{"index": i + 2, "role": "content", "printedLabel": str(i + 3)} for i in range(40)],
]


def zeile(text, x0, y0, x1, y1, size, bold=True, font="Arial-BoldMT", page=3):
    return LayoutLine(
        page_index=page, text=text, x0=x0, y0=y0, x1=x1, y1=y1,
        size=size, max_size=size, font=font, bold=bold,
    )


def dmz_block(lines, page=3):
    return SourceBlock(
        page_index=page,
        text=" ".join(line.text for line in lines),
        x0=min(line.x0 for line in lines),
        y0=min(line.y0 for line in lines),
        x1=max(line.x1 for line in lines),
        y1=max(line.y1 for line in lines),
        size=lines[0].size,
        max_size=max(line.max_size for line in lines),
        font=lines[0].font,
        bold=all(line.bold for line in lines),
        layout_lines=tuple(lines),
    )


def test_dmz_profil_entfernt_umschlag_inhalt_und_kolumnentitel():
    kopf = SourceBlock(
        page_index=5, text="Im Visier", x0=0.13, y0=0.037, x1=0.21, y1=0.056,
        size=16.0, max_size=16.0, font="Arial-BoldMT", bold=True,
    )
    blocks = [
        block("Titelseite", page=0),
        block("Verehrter Leser", page=2, y=0.2),
        block("Inhalt", page=3),
        kopf,
        block("Fliesstext auf Seite 6. " * 10, page=5, y=0.2),
    ]
    images = [bild(page=0), bild(page=2), bild(page=3), bild(page=5)]
    kept_blocks, kept_images, _hints = apply_profile(blocks, images, DMZ_PAGES, "dmz")

    assert [b.page_index for b in kept_blocks] == [2, 5]
    assert [b.text[:9] for b in kept_blocks] == ["Verehrter", "Fliesstex"]
    assert [i.page_index for i in kept_images] == [2, 5]


def test_dmz_kolumnentitel_wird_von_verschmolzener_schlagzeile_geloest():
    verschmolzen = dmz_block(
        [
            zeile("Waffentechnik", 0.13, 0.037, 0.26, 0.056, 16.0, page=7),
            zeile("Rarität wieder aufgetaucht", 0.1, 0.08, 0.6, 0.11, 24.0, page=7),
        ],
        page=7,
    )
    kept, _images, _hints = apply_profile([verschmolzen], [], DMZ_PAGES, "dmz")
    assert len(kept) == 1
    assert kept[0].text == "Rarität wieder aufgetaucht"
    assert kept[0].y0 == pytest.approx(0.08)
    assert len(kept[0].layout_lines) == 1


def test_dmz_inhaltsverzeichnis_liest_seitenzahl_rubrik_und_titel():
    toc = [
        # Kolumnentitel "Inhalt" ist mit dem ersten Eintrag verschmolzen.
        dmz_block([
            zeile("Inhalt", 0.13, 0.037, 0.18, 0.056, 16.0),
            zeile("Im Visier", 0.093, 0.136, 0.156, 0.151, 13.0),
            zeile("Verrat an der Truppe", 0.093, 0.152, 0.26, 0.166, 11.5, font="ACaslon-Bold"),
        ]),
        dmz_block([zeile("6", 0.064, 0.156, 0.077, 0.177, 18.0)]),
        dmz_block([zeile("Immer wieder schwächen", 0.093, 0.166, 0.267, 0.178, 10.0,
                         bold=False, font="RotisSerif")]),
        # Rubrik steht allein, darunter ein zweizeiliger Titel.
        dmz_block([zeile("Waffentechnik", 0.093, 0.41, 0.197, 0.425, 13.0)]),
        dmz_block([zeile("Putins", 0.093, 0.502, 0.147, 0.516, 11.5, font="ACaslon-Bold")]),
        dmz_block([zeile("36", 0.05, 0.506, 0.077, 0.527, 18.0)]),
        dmz_block([zeile("Weltuntergangswaffe", 0.093, 0.517, 0.267, 0.53, 11.5,
                         font="ACaslon-Bold")]),
        # Rubrikenliste rechts: Seitenzahl steht in der Zeile.
        dmz_block([zeile("Rubriken", 0.56, 0.703, 0.626, 0.719, 13.0)]),
        SourceBlock(
            page_index=3, text="35 Nachrichten aus Deutschland", x0=0.517, y0=0.74,
            x1=0.80, y1=0.761, size=11.5, max_size=18.0, font="ACaslon-Bold", bold=True,
        ),
    ]
    editorial = block("Verehrter Leser", page=2, y=0.2)
    hints = extract_dmz_toc(toc + [editorial], DMZ_PAGES, "dmz")
    by_label = {hint.label: hint for hint in hints}

    assert [hint.label for hint in hints] == [
        "Editorial",
        "Verrat an der Truppe",
        "Putins Weltuntergangswaffe",
        "Nachrichten aus Deutschland",
    ]
    assert by_label["Editorial"].page_index == 2
    assert by_label["Editorial"].toc_page_index is None

    verrat = by_label["Verrat an der Truppe"]
    assert verrat.page_index == 5
    assert verrat.toc_page_index == 3
    assert verrat.section == "Im Visier"
    assert not verrat.split_headings
    # Die Klickflaeche umfasst Rubrik, Seitenzahl und Titel der linken Spalte.
    assert verrat.y0 <= 0.136 and verrat.y1 >= 0.177
    assert verrat.x0 < 0.064 and verrat.x1 > 0.26

    putin = by_label["Putins Weltuntergangswaffe"]
    assert putin.page_index == 35
    assert putin.section == "Waffentechnik"

    nachrichten = by_label["Nachrichten aus Deutschland"]
    assert nachrichten.page_index == 34
    assert nachrichten.section == "Rubriken"
    assert nachrichten.split_headings is True
    assert nachrichten.x0 >= 0.5


def test_zwei_rubrikanker_auf_derselben_seite_bleiben_ein_abschnitt():
    blocks = [
        block("Erste Meldung", page=4, kind="heading", y=0.1),
        block("Text der ersten Meldung. " * 20, page=4, y=0.2),
        block("Zweite Meldung", page=4, kind="heading", y=0.5),
        block("Text der zweiten Meldung. " * 20, page=4, y=0.6),
        block("Grosser Folgeartikel", page=7, kind="heading", y=0.1),
        block("Text des Folgeartikels. " * 20, page=7, y=0.2),
    ]
    hints = [
        TocHint("Nachrichten aus Deutschland", 4, 3, 0.5, 0.1, 0.9, 0.14, split_headings=True),
        TocHint("Nachrichten aus aller Welt", 4, 3, 0.5, 0.15, 0.9, 0.19, split_headings=True),
        TocHint("Grosser Folgeartikel", 7, 3, 0.5, 0.2, 0.9, 0.24),
    ]
    articles = assemble(blocks, toc_hints=hints)
    assert [a.title for a in articles] == [
        "Erste Meldung",
        "Zweite Meldung",
        "Grosser Folgeartikel",
    ]
    assert articles[2].pages == [7]


def test_text_vor_dem_ersten_inhaltseintrag_bleibt_erhalten():
    blocks = [
        block("Editorial-Anrede", page=2, kind="heading", y=0.1),
        block("Verehrter Leser, " * 30, page=2, y=0.2),
        block("Erster Artikel", page=4, kind="heading", y=0.1),
        block("Text des ersten Artikels. " * 30, page=4, y=0.2),
    ]
    hints = [TocHint("Erster Artikel", 4, 3, 0.05, 0.1, 0.3, 0.14)]
    articles = assemble(blocks, toc_hints=hints)
    assert [a.title for a in articles] == ["Editorial-Anrede", "Erster Artikel"]


def test_rubrikseite_ohne_ueberschrift_am_anfang_traegt_den_eintragstitel():
    blocks = [
        block("Einleitender Text ohne Ueberschrift. " * 10, page=4, y=0.1),
        block("Zweite Meldung", page=4, kind="heading", y=0.5),
        block("Text der zweiten Meldung. " * 20, page=4, y=0.6),
    ]
    hints = [
        TocHint("Kalenderblatt Ereignisse", 4, 3, 0.5, 0.1, 0.9, 0.14, split_headings=True),
    ]
    articles = assemble(blocks, toc_hints=hints)
    assert [a.title for a in articles] == ["Kalenderblatt Ereignisse", "Zweite Meldung"]


DMZ_HEFT_PAGES = [
    {"index": 0, "role": "front_cover", "printedLabel": "U1"},
    {"index": 1, "role": "inside_front", "printedLabel": "U2"},
    *[{"index": i + 2, "role": "content", "printedLabel": str(i + 3)} for i in range(80)],
    {"index": 82, "role": "inside_back", "printedLabel": "U3"},
    {"index": 83, "role": "back_cover", "printedLabel": "U4"},
]


@has_dmz
def test_dmz_umschlag_doppelseiten_liefern_vier_leserseiten():
    """Zwei Boegen (U4|U1, U2|U3) werden als vier A4-Seiten gelesen."""
    cover = open(DMZ_UMSCHLAG, "rb").read()
    assert render.page_count(cover) == 2
    for source, half in [(0, "left"), (0, "right"), (1, "left"), (1, "right")]:
        _jpeg, width, height = render.render_page(cover, source, width_px=300, half=half)
        # Hochformat wie eine Einzelseite, nicht das Querformat des Bogens.
        assert 0.68 < width / height < 0.73
    _jpeg, width, height = render.render_page(cover, 0, width_px=300)
    assert width / height > 1.3

    # Dieselbe Quellseite liefert zwei Leserseiten mit getrenntem Text.
    blocks, _images = extract_pdf_pages(
        cover,
        [(0, 0), (1, 1), (1, 82), (0, 83)],
        {0: "right", 1: "left", 82: "right", 83: "left"},
    )

    def text(index: int) -> str:
        return " ".join(b.text for b in blocks if b.page_index == index)

    assert "Fernspäher" in text(0) and "Fernspäher" not in text(83)
    assert "Historiker" in text(83) and "Historiker" not in text(0)
    assert "Abo" in text(1)
    assert "Waffen-SS" in text(82)
    assert all(0.0 <= b.x0 <= b.x1 <= 1.0 for b in blocks)


@has_dmz
def test_dmz_inhaltsverzeichnis_liefert_ziele_rubriken_und_flaechen():
    data = open(DMZ_HEFT, "rb").read()
    blocks, _images = extract_pdf_pages(data, [(0, 2), (1, 3)])
    hints = extract_dmz_toc(blocks, DMZ_HEFT_PAGES, "dmz")
    by_label = {hint.label: hint for hint in hints}

    assert len(hints) >= 25
    assert by_label["Editorial"].page_index == 2
    assert by_label["Editorial"].toc_page_index is None
    assert by_label["Verrat an der Truppe"].page_index == 5
    assert by_label["Verrat an der Truppe"].section == "Im Visier"
    assert by_label["Orden vom Zähringer Löwen"].page_index == 14
    assert by_label["Putins Weltuntergangswaffe"].section == "Waffentechnik"
    assert by_label["Der Gefangenschaft entflohen"].page_index == 51
    assert by_label["Arctic Convoy – Todesfalle Eismeer"].page_index == 65
    assert by_label["Nachrichten aus Deutschland"].page_index == 34
    assert by_label["Nachrichten aus Deutschland"].split_headings is True
    assert by_label["Leserbriefe/Impressum"].page_index == 81
    gedruckt = [hint for hint in hints if hint.toc_page_index is not None]
    assert all(hint.toc_page_index == 3 for hint in gedruckt)
    assert all(hint.x1 > hint.x0 and hint.y1 > hint.y0 for hint in gedruckt)


@has_dmz
def test_dmz_artikel_folgen_dem_inhaltsverzeichnis():
    data = open(DMZ_HEFT, "rb").read()
    blocks, images = extract_pdf_pages(data, [(i, i + 2) for i in range(80)])
    blocks, images, hints = apply_profile(blocks, images, DMZ_HEFT_PAGES, "dmz")
    articles = assemble(prepare_blocks(blocks, images, 84), images, toc_hints=hints)
    by_title = {article.title: article for article in articles}

    assert by_title["Editorial"].pages == [2]
    assert by_title["Verrat an der Truppe"].pages == [5, 6, 7, 8]
    assert by_title["Der Gefangenschaft entflohen"].pages == [51, 52, 53, 54]
    assert by_title["Kalenderblatt Ereignisse"].pages[0] == 23
    assert 35 <= len(articles) <= 60

    kolumnentitel = {"Waffentechnik", "Spezialeinheiten", "Zweiter Weltkrieg", "Im Visier", "Fahrzeug"}
    assert not kolumnentitel & {article.title for article in articles}
    assert all(
        b.text.strip() not in kolumnentitel for article in articles for b in article.blocks
    )



# --- DMZ-Zeitgeschichte-Profil -------------------------------------------------

def zg_head(text, page):
    """Kolumnentitel oben auf einer Inhaltsseite, 20 pt, nicht fett."""
    return dmz_block([zeile(text, 0.39, 0.03, 0.61, 0.06, 20.7, bold=False, font="Rotis", page=page)], page=page)


def zg_toc_blocks():
    """Verkleinertes Verzeichnis von Seite 3 des Musterhefts Nr. 80 (Seitenindex 2)."""
    z = lambda text, x0, y0, x1, size=11.0, bold=True: zeile(text, x0, y0, x1, y0 + 0.012, size, bold=bold, page=2)
    return [
        dmz_block([zeile("Editorial", 0.45, 0.03, 0.55, 0.06, 20.7, bold=False, page=2)], page=2),
        dmz_block([zeile("80 Jahre nach Bildung der Kampfgruppe. " * 8, 0.06, 0.11, 0.62, 0.57, 11.0, bold=False, page=2)], page=2),
        dmz_block([zeile("Guido Kraus", 0.79, 0.55, 0.88, 0.57, 11.0, bold=False, page=2)], page=2),
        dmz_block([zeile("Inhalt", 0.06, 0.67, 0.15, 0.70, 20.0, page=2)], page=2),
        # Spalte 1: Rubrik und Titel in einem Block, Seitenzahl daneben.
        dmz_block([z("Waffen\u2011SS im Bild", 0.06, 0.72, 0.20), z("Neuaufstellung", 0.06, 0.733, 0.20)], page=2),
        dmz_block([z("4", 0.30, 0.733, 0.31)], page=2),
        dmz_block([z("An den Fronten", 0.06, 0.76, 0.18)], page=2),
        dmz_block([z("Russen verteidigen das Elsaß", 0.06, 0.78, 0.28)], page=2),
        dmz_block([z("6", 0.30, 0.78, 0.31)], page=2),
        dmz_block([z("Die 30. Waffen-Grenadier-Division der SS", 0.06, 0.793, 0.29, size=8.0)], page=2),
        dmz_block([z("Vorstoß über den Mscha", 0.06, 0.83, 0.25)], page=2),
        dmz_block([z("18", 0.30, 0.83, 0.31)], page=2),
        # Spalte 2: zweizeiliger Titel unter einer Rubrik, Seitenzahl an der letzten Zeile.
        dmz_block([z("Soldatenporträt", 0.36, 0.64, 0.50), z("Standartenführer", 0.36, 0.653, 0.50), z("Alfons Rebane", 0.36, 0.666, 0.50)], page=2),
        dmz_block([z("10", 0.60, 0.666, 0.61)], page=2),
        dmz_block([z("Ein Porträt zum 50. Todestag", 0.36, 0.68, 0.52, size=8.0)], page=2),
        dmz_block([z("Kalenderblatt Personen", 0.36, 0.70, 0.54)], page=2),
        dmz_block([z("16", 0.60, 0.70, 0.61)], page=2),
        # Spalte 3: Bildzeile ohne Seitenzahl ist kein Eintrag.
        dmz_block([z("Titelseite: Panzerkampfwagen IV", 0.67, 0.88, 0.89, size=10.0)], page=2),
        dmz_block([zeile("DMZ ZEITGESCHICHTE Nr. 80", 0.40, 0.95, 0.60, 0.97, 13.2, bold=False, page=2)], page=2),
        # Inhaltsseiten mit Kolumnentiteln und Fliesstext.
        zg_head("Waffen\u2011SS im Bild", 3),
        block("Das Foto zeigt den ersten Moerser. " * 10, page=3, y=0.2),
        dmz_block([zeile("DMZ ZEITGESCHICHTE Nr. 80", 0.40, 0.95, 0.60, 0.97, 13.2, bold=False, page=3)], page=3),
        zg_head("An den Fronten", 5),
        block("Die Division kaempfte im Elsass. " * 10, page=5, y=0.2),
        zg_head("Soldatenporträt", 9),
        block("Alfons Rebane wurde geboren. " * 10, page=9, y=0.2),
    ]


def test_dmz_zeitgeschichte_liest_das_verzeichnis_von_seite_3():
    from extractor.publication_profiles import extract_dmz_zeitgeschichte_toc

    hints = extract_dmz_zeitgeschichte_toc(zg_toc_blocks(), DMZ_PAGES, "dmz-zeitgeschichte")
    by_label = {hint.label: hint for hint in hints}
    assert list(by_label) == [
        "Editorial",
        "Neuaufstellung",
        "Russen verteidigen das Elsaß",
        "Vorstoß über den Mscha",
        "Standartenführer Alfons Rebane",
        "Kalenderblatt Personen",
    ]
    assert by_label["Editorial"].page_index == 2
    assert by_label["Editorial"].toc_page_index is None
    assert by_label["Neuaufstellung"].page_index == 3
    assert by_label["Neuaufstellung"].section == "Waffen\u2011SS im Bild"
    assert by_label["Russen verteidigen das Elsaß"].page_index == 5
    assert by_label["Russen verteidigen das Elsaß"].section == "An den Fronten"
    # Die Rubrik gilt weiter, bis eine neue kommt.
    assert by_label["Vorstoß über den Mscha"].page_index == 17
    assert by_label["Vorstoß über den Mscha"].section == "An den Fronten"
    assert by_label["Standartenführer Alfons Rebane"].page_index == 9
    assert by_label["Standartenführer Alfons Rebane"].section == "Soldatenporträt"
    assert by_label["Kalenderblatt Personen"].page_index == 15
    assert by_label["Kalenderblatt Personen"].split_headings is True
    # Trefferflaechen liegen auf Seite 3 in der jeweiligen Spalte.
    neu = by_label["Neuaufstellung"]
    assert neu.toc_page_index == 2
    assert neu.x0 < 0.1 and neu.x1 < 0.34
    assert 0.71 <= neu.y0 <= 0.72 and neu.y1 < by_label["Russen verteidigen das Elsaß"].y0 + 0.01


def test_dmz_zeitgeschichte_behaelt_editorial_und_seite_4_und_streicht_verzeichnis():
    kept_blocks, _images, hints = apply_profile(zg_toc_blocks(), [], DMZ_PAGES, "dmz-zeitgeschichte")
    seite_3 = [b.text[:12] for b in kept_blocks if b.page_index == 2]
    assert seite_3 == ["80 Jahre nac", "Guido Kraus"]
    # Seite 4 ist eine Inhaltsseite, nur Kolumnentitel und Fusszeile fallen weg.
    assert [b.text[:12] for b in kept_blocks if b.page_index == 3] == ["Das Foto zei"]
    assert len(hints) == 6
