"""Artikel aus den Stories des Satzes."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.idml_articles import (  # noqa: E402
    artikel_aus_satz,
    initialen_einsetzen,
    rolle_fuer,
    stories_bilden,
)
from extractor.model import SourceBlock, SourceImage  # noqa: E402


def block(
    text: str,
    *,
    story: str,
    style: str,
    page: int = 0,
    y0: float = 0.3,
    x0: float = 0.05,
) -> SourceBlock:
    return SourceBlock(
        page_index=page,
        text=text,
        x0=x0,
        y0=y0,
        x1=x0 + 0.4,
        y1=y0 + 0.05,
        kind="paragraph",
        origin="idml",
        story_id=story,
        frame_id=f"{story}-rahmen",
        style_name=style,
        frame_box=(x0, y0, x0 + 0.4, y0 + 0.5),
    )


def test_formatnamen_werden_zu_rollen():
    assert rolle_fuer("Mengentext 2023") == "mengentext"
    assert rolle_fuer("mengentext schwerter") == "mengentext"
    assert rolle_fuer("HÜ Soldatenporträt 2023") == "ueberschrift"
    assert rolle_fuer("UÜ Soldatenporträt 2023") == "unterzeile"
    assert rolle_fuer("hauptüberschrift schwerter") == "ueberschrift"
    assert rolle_fuer("Bildunterschrift DMZ 2023") == "bildunterschrift"
    assert rolle_fuer("Bildquelle") == "quelle"
    assert rolle_fuer("Kasten Text 2023") == "kasten"
    # Blickfang am Seitenrand: kein Text des Artikels.
    assert rolle_fuer("Zungentext DMZ-Zeit 2018") == "schmuckzitat"
    assert rolle_fuer("Zitatkasten 2023") == "schmuckzitat"
    assert rolle_fuer("Seitenrubrik") == "beiwerk"
    assert rolle_fuer("Seitenrubrik ZUERST") == "beiwerk"
    assert rolle_fuer("Inhaltsverzeichnis Überschrift") == "verzeichnis"
    assert rolle_fuer("Zwischenüberschrift rot") == "zwischentitel"
    # Ohne eigenes Format: kurz ist Beiwerk, lang ist Text.
    assert rolle_fuer("$ID/NormalParagraphStyle", 12) == "beiwerk"
    assert rolle_fuer("$ID/NormalParagraphStyle", 900) == "mengentext"


def test_eine_story_wird_ein_artikel_mit_ueberschrift():
    blocks = [
        block("Begeisterter Flieger", story="k1", style="hauptüberschrift", y0=0.09),
        block("Generalfeldmarschall Greim", story="u1", style="unterüberschrift", y0=0.2),
        block("Robert Greim wurde " + "x" * 500, story="t1", style="mengentext", y0=0.07),
        block("Am 14. Juli 1911 trat er ein.", story="t1", style="mengentext", y0=0.5),
        block("Peter Stockert", story="a1", style="autorenname schwerter", y0=0.9),
    ]
    artikel = artikel_aus_satz(blocks)
    assert len(artikel) == 1
    a = artikel[0]
    assert a.title == "Begeisterter Flieger"
    assert a.subtitle == "Generalfeldmarschall Greim"
    assert a.author == "Peter Stockert"
    # Erst die Zeile, dann die Unterzeile, dann der Text in der Reihenfolge
    # des Satzes — nicht nach Hoehe auf der Seite sortiert.
    assert [b.kind for b in a.blocks[:2]] == ["heading", "lead"]
    assert a.blocks[2].text.startswith("Robert Greim wurde")
    assert a.blocks[3].text.startswith("Am 14. Juli")


def test_aufmacher_bringt_die_zeile_auf_die_seite_davor():
    blocks = [
        block("Durchbruch", story="k1", style="hauptüberschrift", page=10, y0=0.09),
        block("Ende 1939 " + "x" * 500, story="t1", style="mengentext", page=11, y0=0.07),
    ]
    artikel = artikel_aus_satz(blocks)
    assert len(artikel) == 1
    assert artikel[0].title == "Durchbruch"


def test_zeile_greift_nicht_ueber_zwei_seiten():
    blocks = [
        block("Weit weg", story="k1", style="hauptüberschrift", page=2, y0=0.09),
        block("Text " + "x" * 500, story="t1", style="mengentext", page=9, y0=0.07),
    ]
    artikel = artikel_aus_satz(blocks)
    assert artikel[0].title != "Weit weg"


def test_ausgelagerte_initiale_kommt_an_ihren_absatz():
    blocks = [
        block("F", story="i1", style="$ID/NormalParagraphStyle", page=8, y0=0.30),
        block(
            "ridolin Rudolf Theodor " + "x" * 500,
            story="t1",
            style="Mengentext Initiale 2023",
            page=8,
            y0=0.30,
        ),
    ]
    stories = initialen_einsetzen(stories_bilden(blocks))
    texte = [b.text for s in stories for b in s.blocks]
    assert any(t.startswith("Fridolin Rudolf") for t in texte)
    # Der Buchstabe steht nicht mehr als eigene Story herum.
    assert all(t.strip() != "F" for t in texte)


def test_kasten_steht_an_seiner_seite_im_lesefluss():
    blocks = [
        block("Titel", story="k1", style="hauptüberschrift", page=0, y0=0.09),
        block("Seite eins " + "x" * 500, story="t1", style="mengentext", page=0, y0=0.3),
        block("Seite zwei " + "x" * 500, story="t1", style="mengentext", page=1, y0=0.3),
        block("Merke dies", story="b1", style="Kasten Text 2023", page=0, y0=0.8),
    ]
    a = artikel_aus_satz(blocks)[0]
    texte = [b.text[:10] for b in a.blocks]
    assert texte.index("Merke dies") < texte.index("Seite zwei")
    assert a.blocks[texte.index("Merke dies")].kind == "box"


def test_zunge_und_seitenrubrik_stehen_nicht_im_fliesstext():
    blocks = [
        block("Titel", story="k1", style="Überschrift DMZ-Zeit 2018", page=0, y0=0.09),
        block(
            "Seite eins " + "x" * 500,
            story="t1",
            style="Mengentext DMZ-Zeit 2018",
            page=0,
            y0=0.3,
        ),
        block(
            "Seite zwei " + "x" * 500,
            story="t1",
            style="Mengentext DMZ-Zeit 2018",
            page=1,
            y0=0.3,
        ),
        # Die Zunge am Seitenrand, im Satz zwei Absaetze einer eigenen Story.
        block(
            "Russische Panzerkorps",
            story="z1",
            style="Zungentext DMZ-Zeit 2018",
            page=0,
            y0=0.68,
        ),
        block(
            "schwer angeschlagen",
            story="z1",
            style="Zungentext DMZ-Zeit 2018",
            page=0,
            y0=0.70,
        ),
        block("Als Diplomat gefragt.", story="z2", style="Zitatkasten 2023", page=1, y0=0.5),
        block("Geschichte", story="r1", style="Seitenrubrik", page=1, y0=0.03),
    ]
    [a] = artikel_aus_satz(blocks)
    assert [b.text[:10] for b in a.blocks] == ["Titel", "Seite eins", "Seite zwei"]


def test_zitat_im_mengentext_bleibt_stehen():
    # Ein Zitat, das der Autor in den Text gesetzt hat, gehoert zur Story des
    # Artikels. Nur der Blickfang im eigenen Rahmen faellt weg.
    blocks = [
        block("Titel", story="k1", style="hauptüberschrift", page=0, y0=0.09),
        block("Davor " + "x" * 500, story="t1", style="mengentext", page=0, y0=0.3),
        block("So sprach der General.", story="t1", style="Zitat im Text", page=0, y0=0.5),
        block("Danach " + "x" * 500, story="t1", style="mengentext", page=0, y0=0.6),
    ]
    [a] = artikel_aus_satz(blocks)
    assert "So sprach der General." in [b.text for b in a.blocks]


def test_kurze_meldung_nimmt_ihren_ersten_absatz_als_zeile():
    blocks = [
        block(
            "Philipp Wild geboren",
            story="t1",
            style="Überschrift Kalenderblatt DMZ-Zeit 2018",
            page=13,
            y0=0.07,
        ),
        block(
            "Aus dem hessischen Kreis " + "x" * 500,
            story="t1",
            style="Mengentext DMZ-Zeit 2018",
            page=13,
            y0=0.12,
        ),
    ]
    a = artikel_aus_satz(blocks)[0]
    assert a.title == "Philipp Wild geboren"
    assert a.blocks[0].kind == "heading"


class _Rahmen:
    """Ein Rahmen, wie ihn `extract_idml_frames` liefert."""

    def __init__(self, page, x0, y0, x1, y1, story=""):
        self.page_number = page
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
        self.story_id = story
        self.link = "bild.tif"


def test_bild_unter_einem_kasten_ist_schmuck():
    from extractor.idml_articles import ohne_unterlagen

    # Der gelbe Klebezettel: der Kastentext steckt im Bildrahmen.
    zettel = _Rahmen(9, 0.252, 0.221, 0.523, 0.398)
    kasten = _Rahmen(9, 0.281, 0.243, 0.479, 0.366, story="s1")
    uebrig = ohne_unterlagen([zettel], [kasten], {"s1": "kasten"})
    assert uebrig == []


def test_foto_mit_textspalte_darauf_bleibt():
    from extractor.idml_articles import ohne_unterlagen

    # Ein Aufmacherfoto, ueber dem eine Textspalte liegt: kein Schmuck.
    foto = _Rahmen(12, 0.0, 0.0, 1.0, 1.0)
    spalte = _Rahmen(12, 0.05, 0.1, 0.5, 0.9, story="s1")
    uebrig = ohne_unterlagen([foto], [spalte], {"s1": "mengentext"})
    assert uebrig == [foto]


def test_karte_mit_beschriftung_bleibt():
    from extractor.idml_articles import ohne_unterlagen

    # Kleine Beschriftungen in einer Karte decken zu wenig Flaeche ab.
    karte = _Rahmen(4, 0.0, 0.0, 0.6, 0.6)
    marke = _Rahmen(4, 0.1, 0.1, 0.2, 0.15, story="s1")
    uebrig = ohne_unterlagen([karte], [marke], {"s1": "beiwerk"})
    assert uebrig == [karte]


def test_papierrahmen_um_ein_foto_ist_schmuck():
    from extractor.idml_articles import ohne_unterlagen

    # DMZ-Zeitgeschichte 80, S. 9: "Bilderrahmen hoch.tif" mit dem Foto darin.
    rahmen = _Rahmen(8, 0.509, 0.060, 0.982, 0.537)
    foto = _Rahmen(8, 0.530, 0.080, 0.962, 0.517)
    uebrig = ohne_unterlagen([rahmen, foto], [], {})
    assert uebrig == [foto]


def test_aufmacher_mit_eingeklinktem_bild_bleibt():
    from extractor.idml_articles import ohne_unterlagen

    # Das kleine Bild fuellt den Aufmacher nur zu einem Viertel.
    aufmacher = _Rahmen(12, 0.0, 0.0, 1.0, 1.0)
    klein = _Rahmen(12, 0.5, 0.5, 1.0, 1.0)
    uebrig = ohne_unterlagen([aufmacher, klein], [], {})
    assert uebrig == [aufmacher, klein]


def test_gefaecherte_bilder_bleiben_alle():
    from extractor.idml_articles import ohne_unterlagen

    # Drei Buchtitel als Faecher: sie ueberdecken sich, keiner steckt im anderen.
    baende = [_Rahmen(11, 0.10 + 0.03 * i, 0.10 + 0.02 * i, 0.40 + 0.03 * i, 0.50 + 0.02 * i) for i in range(3)]
    assert ohne_unterlagen(baende, [], {}) == baende


def test_deckungsgleiche_rahmen_bleiben_beide():
    from extractor.idml_articles import ohne_unterlagen

    # Dass beide dasselbe zeigen, merkt erst der Worker am fertigen Bild.
    a = _Rahmen(0, 0.486, 0.867, 0.853, 0.933)
    b = _Rahmen(0, 0.486, 0.867, 0.853, 0.933)
    assert ohne_unterlagen([a, b], [], {}) == [a, b]


def test_zeilen_finden_ihren_text_in_der_eigenen_spalte():
    """Meldungsseite in zwei Spalten: die Zeile links oben gehoert zum Text links."""
    blocks = [
        block("Richterbund: Neue Asylklagewelle droht", story="k1", style="Kleine Überschrift rot", page=3, y0=0.06, x0=0.05),
        block("Der Deutsche Richterbund hält die Reform " + "x" * 700, story="t1", style="Mengentext mit Initiale", page=3, y0=0.10, x0=0.05),
        block("BAMF widerruft Status fast nie", story="k2", style="Kleine Überschrift rot", page=3, y0=0.07, x0=0.36),
        block("Das Bundesamt für Migration " + "y" * 700, story="t2", style="Mengentext mit Initiale", page=3, y0=0.09, x0=0.37),
    ]
    artikel = artikel_aus_satz(blocks)
    paare = {a.title: a.blocks[-1].text[:12] for a in artikel}
    assert paare == {
        "Richterbund: Neue Asylklagewelle droht": "Der Deutsche",
        "BAMF widerruft Status fast nie": "Das Bundesam",
    }


def test_bild_im_rahmen_der_kleinen_meldung_bleibt_dort():
    """Zwei Meldungen untereinander in einer Spalte: das Kalenderblatt steht im
    Rahmen der kleinen unteren, auch wenn die obere viel mehr Text hat."""
    blocks = [
        block("Georg Hurdelbrink wird Untersturmführer", story="k1", style="Kleine Überschrift rot", page=3, y0=0.06, x0=0.05),
        block("Am 20. April 1942 wurde Georg " + "x" * 2000, story="t1", style="Mengentext mit Initiale", page=3, y0=0.10, x0=0.05),
        block("Albert Hektor gefallen", story="k2", style="Kleine Überschrift rot", page=3, y0=0.62, x0=0.05),
        block("Während der schweren Abwehrkämpfe " + "y" * 400, story="t2", style="Mengentext mit Initiale", page=3, y0=0.66, x0=0.05),
    ]
    # Der obere Rahmen reicht bis 0.60, der untere von 0.66 bis 0.95.
    blocks[1].frame_box = (0.05, 0.10, 0.45, 0.60)
    blocks[3].frame_box = (0.05, 0.66, 0.45, 0.95)
    kalenderblatt = SourceImage(page_index=3, x0=0.05, y0=0.66, x1=0.19, y1=0.75)
    artikel = artikel_aus_satz(blocks, [kalenderblatt])
    bilder = {a.title: len(a.images) for a in artikel}
    assert bilder == {"Georg Hurdelbrink wird Untersturmführer": 0, "Albert Hektor gefallen": 1}
