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
from extractor.article_assembler import assemble  # noqa: E402
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
from extractor.model import SourceBlock, SourceImage  # noqa: E402
from extractor.pdf_extract import (  # noqa: E402
    _split_line_at_gaps,
    _words_to_lines,
    attach_captions,
    extract_pdf_pages,
    mark_furniture,
    prepare_blocks,
)
from extractor.textutil import clean_text, glue_dropcap  # noqa: E402
from tests import idml_fixture  # noqa: E402

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


# --- Weisser Rand im Rendering --------------------------------------------


def _jpeg(image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


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
