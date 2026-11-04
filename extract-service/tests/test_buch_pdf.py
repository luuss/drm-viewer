"""Buch-Modus aus der Textebene des PDF (extractor/buch_pdf.py)."""

from extractor.buch_pdf import buch_aus_textebene
from extractor.toc_layout import TextItem


def T(text, x0, y0, x1, size=12, h=0.019):
    return TextItem(text, x0, y0, x1, y0 + h, size)


def _seite_zweispaltig():
    return [
        T("Im Vorhof der Hölle", 0.10, 0.084, 0.31),  # Kolumnentitel
        T("5", 0.88, 0.083, 0.89),  # Seitenzahl
        T("S", 0.10, 0.29, 0.18, size=70, h=0.11),  # Initiale
        T("chon von weitem hörten", 0.18, 0.321, 0.487),
        T("die sich in langer Marsch", 0.18, 0.343, 0.478),
        T("-", 0.478, 0.343, 0.487),
        T("kolonne nähernden Landser", 0.18, 0.364, 0.487),
        T("des Regiments das Grollen der", 0.10, 0.386, 0.487),
        T("Front. Die Stadt hieß Stalin", 0.10, 0.408, 0.478),  # Strich fehlt
        T("grad, wo die Truppen lagen.", 0.10, 0.430, 0.40),
        T("Der Obergefreite Gutschke* war", 0.125, 0.452, 0.487),
        T("müde und hatte keine Lust", 0.10, 0.474, 0.487),
        T("* Name frei gestaltet.", 0.10, 0.90, 0.40, size=7.5, h=0.012),  # Fussnote
        T("mehr zu marschieren.", 0.51, 0.12, 0.70),  # rechte Spalte, Fortsetzung
        T("„Halt!“, rief einer.", 0.53, 0.142, 0.75),
    ] + [T(f"Fülltext Zeile {n} rechts", 0.51, 0.2 + n * 0.0215, 0.89) for n in range(6)]


def test_zweispaltig_mit_initiale_trennung_und_fussnote():
    a = buch_aus_textebene({4: _seite_zweispaltig()}, set(), "Im Vorhof der Hölle")[0]
    texte = [b.text for b in a.blocks]
    assert not any(t in ("5", "Im Vorhof der Hölle") for t in texte)
    assert texte[0] == (
        "Schon von weitem hörten die sich in langer Marschkolonne nähernden Landser "
        "des Regiments das Grollen der Front. Die Stadt hieß Stalingrad, wo die Truppen lagen."
    )
    # Der Absatz laeuft in die rechte Spalte weiter; die Fussnote steht dahinter.
    assert texte[1] == "Der Obergefreite Gutschke* war müde und hatte keine Lust mehr zu marschieren."
    assert texte[2] == "„Halt!“, rief einer."
    assert texte.index("* Name frei gestaltet.") > 1


def test_kapitelzeile_und_werbeseite():
    kapitel = [T("Der Vorstoß auf Libau", 0.1, 0.2, 0.6, size=18, h=0.03)] + [
        T(f"Erzähltext Zeile {n} mit genug Wörtern.", 0.1, 0.25 + n * 0.0215, 0.88) for n in range(8)
    ]
    werbung = [T(w, 0.1, 0.15 + n * 0.06, 0.5, size=20, h=0.04) for n, w in enumerate(
        ["DIE NEUEN HEFTE", "Flieger", "Marine", "Magazin", "Legion", "Freikorps"]
    )]
    a = buch_aus_textebene({10: kapitel, 11: werbung}, set(), "x")[0]
    assert [b.text for b in a.blocks if b.kind == "heading"] == ["Der Vorstoß auf Libau"]
    assert {b.page_index for b in a.blocks} == {10}


def test_ohne_text_kein_artikel():
    assert buch_aus_textebene({}, set(), "x") == []


def test_einleitung_und_geschichte_ein_text_seiten_getrennt():
    # Ein Text je Heft; vorne beginnt jede Seite einen eigenen Absatz.
    vorne = [T("Im Vorhof der Hölle", 0.1, 0.2, 0.6, size=18, h=0.03)] + [
        T(f"Einleitung Zeile {n} mit Text.", 0.1, 0.3 + n * 0.0215, 0.88) for n in range(5)
    ]
    weiter = [T(f"Einleitung geht weiter {n}.", 0.1, 0.15 + n * 0.0215, 0.88) for n in range(5)]
    geschichte = [
        T("S", 0.10, 0.29, 0.18, size=70, h=0.11),
        T("chon von weitem hörten", 0.18, 0.321, 0.88),
        T("die Landser das Grollen.", 0.18, 0.343, 0.6),
    ] + [T(f"Erzähltext Zeile {n} mit Wörtern.", 0.1, 0.45 + n * 0.0215, 0.88) for n in range(6)]
    arts = buch_aus_textebene({2: vorne, 3: weiter, 4: geschichte}, set(), "Im Vorhof der Hölle")
    assert [a.title for a in arts] == ["Im Vorhof der Hölle"]
    texte = [b.text for b in arts[0].blocks]
    assert any(t.startswith("Schon von weitem") for t in texte)
    assert any(b.page_index == 3 and b.text.startswith("Einleitung geht weiter 0") for b in arts[0].blocks)
