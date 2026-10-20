"""Bilder einer Meldungsseite stehen im Lesetext bei ihrer Meldung.

Vorlage: DMZ 170, Seite 51 "Nachrichten aus aller Welt", Rahmen und Bilder
aus dem Satz (DMZ 170.idml). Vier Meldungen untereinander, die Bilder
abwechselnd rechts (im Textrahmen, der Text laeuft darum) und links (neben
dem Rahmen). Ohne Anker stellte der Reader drei der vier Bilder hinter die
letzte Meldung.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from extractor.article_assembler import _attach_images, meldungsanker  # noqa: E402
from extractor.model import AssembledArticle, SourceBlock, SourceImage  # noqa: E402

SEITE = 50


def _block(kind: str, text: str, rahmen: tuple[float, float, float, float]) -> SourceBlock:
    x0, y0, x1, y1 = rahmen
    return SourceBlock(
        page_index=SEITE,
        text=text,
        x0=x0,
        y0=y0,
        x1=x1,
        y1=y1,
        kind=kind,
        origin="idml",
        frame_box=rahmen,
    )


def _bild(x0: float, y0: float, x1: float, y1: float) -> SourceImage:
    return SourceImage(page_index=SEITE, x0=x0, y0=y0, x1=x1, y1=y1)


# Je Meldung eine Story: Zeile und Text im selben Rahmen.
MELDUNGEN = [
    ("Tschechien für Beschaffung des CV90-Schützenpanzers", (0.0476, 0.0766, 0.9524, 0.2652)),
    ("Frankreich bestellt neue AWACS-Aufklärer", (0.5476, 0.2971, 0.9524, 0.5025)),
    ("Trump kündigt „Trump-Klasse“-Schiffe an", (0.0476, 0.4941, 0.5, 0.7029)),
    ("Spannungen im Philippinischen Meer", (0.0476, 0.7278, 0.9524, 0.9332)),
]
BILDER = {
    "CV90": (0.5765, 0.0768, 0.952, 0.2649),  # rechts im Rahmen der ersten Meldung
    "AWACS": (0.048, 0.2999, 0.4997, 0.4846),  # links neben dem Rahmen
    "Zerstörer": (0.548, 0.5154, 0.952, 0.6967),  # rechts neben dem Rahmen
    "Manila": (0.048, 0.7654, 0.5235, 0.9299),  # links im Rahmen
}


def _seite_51() -> tuple[AssembledArticle, dict[str, SourceImage]]:
    bloecke = []
    for zeile, rahmen in MELDUNGEN:
        bloecke.append(_block("subheading", zeile, rahmen))
        bloecke.append(_block("paragraph", "Meldungstext " + zeile, rahmen))
    artikel = AssembledArticle(title="Nachrichten aus aller Welt", blocks=bloecke)
    bilder = {name: _bild(*box) for name, box in BILDER.items()}
    return artikel, bilder


def test_jedes_bild_haengt_an_der_zeile_seiner_meldung():
    artikel, bilder = _seite_51()
    _attach_images([artikel], list(bilder.values()))
    zeilen = [b for b in artikel.blocks if b.kind == "subheading"]
    erwartet = {"CV90": 0, "AWACS": 1, "Zerstörer": 2, "Manila": 3}
    for name, nummer in erwartet.items():
        assert bilder[name].after_block is zeilen[nummer], name


def test_zwei_spalten_entscheidet_die_breite():
    links_oben = (0.05, 0.05, 0.48, 0.45)
    rechts_oben = (0.52, 0.05, 0.95, 0.45)
    links_unten = (0.05, 0.5, 0.48, 0.95)
    rechts_unten = (0.52, 0.5, 0.95, 0.95)
    bloecke = []
    for name, rahmen in (
        ("A", links_oben),
        ("B", links_unten),
        ("C", rechts_oben),
        ("D", rechts_unten),
    ):
        bloecke += [_block("subheading", name, rahmen), _block("paragraph", name, rahmen)]
    artikel = AssembledArticle(title="Politikmeldungen", blocks=bloecke)
    bild_c = _bild(0.55, 0.25, 0.92, 0.42)
    bild_b = _bild(0.06, 0.55, 0.45, 0.7)
    artikel.images = [bild_c, bild_b]
    meldungsanker(artikel)
    assert bild_c.after_block.text == "C"
    assert bild_b.after_block.text == "B"


def test_langer_artikel_mit_zwischentiteln_bleibt_ohne_anker():
    rahmen = (0.05, 0.05, 0.95, 0.95)
    bloecke = [
        _block("paragraph", "Fortsetzung von der Vorseite", rahmen),
        _block("subheading", "Erster Zwischentitel", rahmen),
        _block("paragraph", "Text", rahmen),
        _block("subheading", "Zweiter Zwischentitel", rahmen),
        _block("paragraph", "Text", rahmen),
    ]
    artikel = AssembledArticle(title="Langer Artikel", blocks=bloecke)
    bild = _bild(0.1, 0.4, 0.5, 0.6)
    artikel.images = [bild]
    meldungsanker(artikel)
    assert bild.after_block is None


def test_vorhandener_anker_bleibt():
    artikel, bilder = _seite_51()
    bild = bilder["AWACS"]
    bild.after_block_order = 7
    artikel.images = [bild]
    meldungsanker(artikel)
    assert bild.after_block is None and bild.after_block_order == 7
