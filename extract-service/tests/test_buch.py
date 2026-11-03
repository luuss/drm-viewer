"""Buch-Modus: ein Heft als ein durchgehender Text (extractor/buch.py)."""

from extractor.buch import buch_aus_satz
from extractor.model import SourceBlock, SourceImage

LANG = "Der Wagen braust Memel entgegen, und die Landser schweigen. " * 10


def _b(seite, text, story, y=0.5, stil="weltkrieg kapitelüberschrift"):
    return SourceBlock(
        page_index=seite,
        text=text,
        x0=0.1,
        y0=y,
        x1=0.9,
        y1=y + 0.05,
        origin="idml",
        story_id=story,
        style_name=stil,
        kind="heading",
    )


def _heft():
    return [
        _b(2, LANG, "einleitung", 0.2, "weltkrieg einleitungstext"),
        _b(4, "Der Vorstoß auf Libau", "kap1", 0.2),
        _b(4, LANG, "haupt", 0.3),
        _b(4, LANG, "haupt", 0.6),
        _b(5, "Bildquelle: Public domain, via Wikimedia Commons", "nachweis", 0.8),
        _b(5, "* MG = Maschinengewehr", "fuss", 0.92, "weltkrieg fußnoten"),
        _b(5, LANG, "haupt", 0.2),
        _b(6, "Der Vorstoß auf Libau", "karte", 0.8),
        _b(6, "* * *", "haupt", 0.3),
        _b(6, LANG, "haupt", 0.4),
        _b(7, "Kampf um die Inseln", "kap2", 0.1),
        _b(7, LANG, "haupt", 0.2),
    ]


def test_ein_text_trotz_ueberschriftformat():
    # Der Fliesstext steht im Format "kapitelüberschrift" und kam frueher
    # gar nicht in den Leser (Weltkrieg 159).
    artikel = buch_aus_satz(_heft(), [], "Der lange Schatten")
    assert len(artikel) == 1
    a = artikel[0]
    assert a.title == "Der lange Schatten"
    absaetze = [b for b in a.blocks if b.kind == "paragraph" and b.story_id == "haupt"]
    assert len(absaetze) == 6  # mit dem Szenenwechsel "* * *"


def test_kapitel_nachweise_fussnoten():
    a = buch_aus_satz(_heft(), [], "x")[0]
    kapitel = [b.text for b in a.blocks if b.kind == "heading"]
    # Die wiederholte Zeile auf S. 6 ist die Ueberschrift einer Karte.
    assert kapitel == ["Der Vorstoß auf Libau", "Kampf um die Inseln"]
    texte = [b.text for b in a.blocks]
    assert not any(t.startswith("Bildquelle") for t in texte)
    # Fussnote hinter dem letzten Absatz ihrer Seite, nicht am Heftende.
    seite5 = [b.text for b in a.blocks if b.page_index == 5]
    assert seite5[-1].startswith("* MG")
    assert "* * *" in texte


def test_reihenfolge_nach_seite():
    a = buch_aus_satz(_heft(), [], "x")[0]
    seiten = [b.page_index for b in a.blocks]
    assert seiten == sorted(seiten)
    assert a.blocks[0].story_id == "einleitung"


def test_text_an_anzeigenbild_bleibt_draussen():
    blocks = _heft() + [_b(8, "HEFTE EINZELN NACHKAUFEN ODER ABONNIEREN", "abo", 0.4), _b(8, LANG, "haupt", 0.1)]
    anzeige = SourceImage(page_index=8, x0=0.1, y0=0.5, x1=0.5, y1=0.8, anzeige=True)
    a = buch_aus_satz(blocks, [anzeige], "x")[0]
    assert not any("NACHKAUFEN" in b.text for b in a.blocks)
    assert anzeige not in a.images
